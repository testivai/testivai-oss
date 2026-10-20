# testivai-oss — Agent Guide

Universal guide for AI coding assistants (Claude Code, Cursor, GitHub Copilot, Gemini, etc.)
working inside this repository.

For Claude Code specifically, see `CLAUDE.md`.
For task recipes, see `SKILLS.md`.

---

## What this repo is

The public open-source home for the TestivAI visual regression SDKs.
Everything here runs **fully locally** — no account, no API key, no server.

---

## Hard rules — never violate these

1. **pnpm only.** Never run `npm install` or `yarn` in the workspace root or any package.
   `action/` is a workspace package too: add its dependencies with `pnpm --filter testivai-action add`.

2. **Local-first, OSS-only.** There is no hosted service. Never reference a cloud
   product, dashboard, account, or API key in docs or code. AI explanation is
   bring-your-own-model via `@testivai/mcp` (`explain_snapshot`).
   Core vocabulary: pixel diff, DOM diff, noise hint, layered analysis, baselines, threshold.

3. **`action/dist/` must always be committed.** After any change to `action/src/`,
   rebuild with `cd action && pnpm run build` and commit the updated `dist/index.js`,
   `dist/review.cjs` and `dist/publish.cjs`.
   CI enforces this.

4. **Every public API change needs a changeset.** Run `pnpm changeset` and commit the
   generated `.changeset/*.md` file with your PR.

5. **Do not push tags manually without understanding the action versioning scheme.**
   Semver tags (`v1.x.y`) roll the `v1` major tag automatically via CI. See the
   "Action versioning" section below.

---

## Repo layout

```
packages/
  witness/      @testivai/witness           core SDK: CLI, diff engine, baselines, HTML report
  playwright/   @testivai/witness-playwright Playwright reporter + capture adapter
  webdriverio/  @testivai/witness-webdriverio WebdriverIO service + capture
  selenium/     @testivai/witness-selenium   Selenium adapter
  mcp/          @testivai/mcp                MCP server: results + diff images for AI agents

action/         testivai/testivai-oss@v1     GitHub Action: post PR comment + commit status
approve/        testivai/testivai-oss/approve@v1  GitHub Action: /testivai approve command handler
review/         testivai/testivai-oss/review@v1   GitHub Action: Claude triages each diff (advisory; enabled: false turns it off)
publish/        testivai/testivai-oss/publish@v1  GitHub Action: publishes reports to GitHub Pages (rebuilt from checked data) and links them in PR comments

examples/       minimal working examples per framework
docs/           public Markdown documentation
e2e/            OSS smoke E2E test suite
```

---

## Package manager

**pnpm** workspace. Version pinned in the root `package.json` `packageManager` field.

```bash
pnpm install          # install all workspace deps
pnpm build            # tsc compile all packages
pnpm test             # jest unit tests across all packages
pnpm e2e              # smoke E2E suite
pnpm pack:dry         # dry-run publish to validate artifacts
pnpm changeset        # add a changeset for a public API change
pnpm version-packages # bump versions from pending changesets (CI only)
pnpm release          # publish to npm (CI only — requires NPM_TOKEN)
```

---

## Architecture

```
User test
  → witness(page, testInfo, 'name')
  → @testivai/witness-playwright  captures screenshot + DOM snapshot + element map
  → @testivai/witness BaselineStore
      first run  → writes .testivai/baselines/<name>/{screenshot.png, dom.html, elements.json, metadata.json}
      later runs → writes .testivai/temp/<name>/...
                   pixel-diffs baseline vs temp
                   DOM-diffs baseline.dom.html vs temp.dom.html
                   compares element maps: style check, attribution, page shift
  → reporter writes visual-report/results.json + visual-report/index.html

CI — GitHub Actions
  → testivai/testivai-oss@v1
      reads results.json
      bundles .testivai/temp/ → visual-report/pending-baselines/
      uploads testivai-visual-report artifact
      posts PR comment + commit status
  → developer comments /testivai approve [name|--all]
  → testivai/testivai-oss/approve@v1
      verifies commenter has write access
      downloads artifact
      copies pending-baselines/<name>/ → .testivai/baselines/<name>/
      commits updated baselines to PR branch
      pushed with a PAT/App token → CI runs again → passes
      (GitHub starts no run for a GITHUB_TOKEN push)
```

---

## Key files

### @testivai/witness (`packages/witness/`)

| File | Responsibility |
|---|---|
| `src/baselines/store.ts` | BaselineStore: read/write/approve/undo baselines and temp |
| `src/diff/diff.ts` | Pixel comparison (pixelmatch) |
| `src/diff/dom-diff.ts` | Zero-dep DOM tokenizer + multiset comparator; emits noiseHint |
| `src/report/compare.ts` | Orchestrates diff, writes images to `visual-report/images/` |
| `src/capture/environment.ts` | Capture provenance: the `environment` block every adapter records in metadata.json |
| `src/report/environment.ts` | What changed since the baseline (`delta`, `renderingDelta`), `isRenderingDrift()`, shared wording |
| `src/report/diff-shape.ts` | `diffShape()`: scattered / concentrated / large, when matching styles still mean likely render noise (shared by compare, the report, MCP and the action) |
| `src/report/generator.ts` | Writes `results.json` + renders `index.html` |
| `src/report/template.ts` | Self-contained HTML template for the report; escapes every value it shows; `snapshotAnchorId()` gives each snapshot a link target (`#snap-<name>`) |
| `src/capture/stable-capture.ts` | Fresh-frame wait + capture until two in a row match (Chrome can return a wrong-viewport frame in a beyond-viewport capture); shared by the standalone CLI and the Playwright and Selenium adapters |

### @testivai/witness-playwright (`packages/playwright/`)

| File | Responsibility |
|---|---|
| `src/snapshot.ts` | `witness()` entry point (`testivai.witness` and `snapshot` are kept as aliases) |
| `src/capture/full-page.ts` | Full-page CDP capture: fresh frame, measure, capture until two in a row match |
| `src/reporter.ts` | Playwright reporter — reads config, calls compare, generates report |

### @testivai/witness-selenium (`packages/selenium/`)

| File | Responsibility |
|---|---|
| `src/witness.ts` | `witness()` entry point; viewport screenshot when the driver has no CDP |
| `src/capture/full-page.ts` | Full-page CDP capture on Chrome/Edge: fresh frame, measure, capture until two in a row match |

### @testivai/mcp (`packages/mcp/`)

| File | Responsibility |
|---|---|
| `src/server.ts` | Registers the tools and the `review-visual-changes` and `triage-visual-diff` prompts; starts the stdio server on import |
| `src/tool-meta.ts` | Every tool's title and description (what the model reads before calling a tool), and the prompt texts; `TRIAGE_PROMPT.rubric()` is shared with the review action |
| `src/lib.ts` | `verdictFor()` one-line verdicts, `explainSnapshot()` evidence bundle, approve helpers (reuse witness BaselineStore) |
| `src/diff-images.ts` | What `get_diff` returns: the full page downscaled, then native-scale crops of the changed regions (`planCrops`, caps in `CROP_LIMITS`), or one region or band on request |

### GitHub Action reporter (`action/`)

| File | Responsibility |
|---|---|
| `src/index.ts` | Main: reads results.json, bundles pending-baselines, uploads artifact, posts comment |
| `src/comment.ts` | Builds PR comment markdown |
| `src/status.ts` | Determines pass/fail commit status |
| `src/types.ts` | Shared TypeScript interfaces |
| `src/review.ts` | The review action's logic: when it runs, the triage prompt (MCP rubric), Claude's tools and output schema, the comment |
| `src/publish.ts` | The publish action's two github-script steps: `build` (decide, build the site) and `finish` (after the deploy: check it answers, add the links) |
| `src/publish/pages.ts` | Whether to publish, from the repository's Pages settings; a non-public repository with a public site needs `TESTIVAI_PUBLIC_REPORTS=true` |
| `src/publish/plan.ts` | Which runs go on the site: each open pull request's last runs (forks included) and the default branch's latest, under a size budget; folders named from numbers only |
| `src/publish/archive.ts` | Reads an untrusted report ZIP: only results.json, the run stamp and the PNGs, inflated in slices with caps |
| `src/publish/png.ts` | `checkPng`: a PNG of sane dimensions, or refused |
| `src/publish/site.ts` | Each run's page rebuilt with the report template from `parseReportData` output (images at numbered paths, CSP, noindex), the index pages and 404 |
| `src/publish/comments.ts` | The PR comment after a publish: rebuild the reporter's when its run marker matches; a fork gets the bot's own, numbers and links only |
| `src/publish/cache.ts` | Opt-in (`cache: true`): report ZIPs kept between publishes (`actions/cache`), used only when their SHA-256 is the digest GitHub lists for the artifact; pages are still rebuilt every time |
| `src/publish/build.ts`, `src/publish/api.ts` | The orchestration (`buildSite`, `finishPublish`) and the GitHub API calls it makes |
| `dist/index.js`, `dist/review.cjs`, `dist/publish.cjs` | Bundled output (esbuild) — **must be committed after every src change** |

### GitHub Action AI triage (`review/`)

| File | Responsibility |
|---|---|
| `action.yml` | Composite action: prepare → `anthropics/claude-code-action@v1` → post; loads `action/dist/review.cjs` |

### GitHub Action Pages publisher (`publish/`)

| File | Responsibility |
|---|---|
| `action.yml` | Composite action: `actions/cache/restore@v6` (with `cache: true`) → github-script build → `actions/cache/save@v6` (with `cache: true`) → `actions/upload-pages-artifact@v5` → `actions/deploy-pages@v5` → github-script finish; loads `action/dist/publish.cjs`; never checks out code |

### GitHub Action approver (`approve/`)

| File | Responsibility |
|---|---|
| `action.yml` | Composite action; its reply step loads `action/dist/approve.cjs` (`action/src/approve.ts`: names the approved run, links its published report from the TestivAI comment) |

---

## On-disk contract — `.testivai/` directory

```
.testivai/
  config.json                    see LocalConfig in packages/witness/src/config/local-config.ts
  baselines/
    <name>/
      screenshot.png             committed reference screenshot
      dom.html                   committed DOM snapshot
      elements.json              element map (boxes + computed-style digests); optional
      metadata.json              { name, createdAt, updatedAt, environment, ... } (environment frozen on approve)
  temp/                          gitignored — current run artifacts
    <name>/
      screenshot.png
      dom.html
      elements.json
      metadata.json              { environment, masks, ... } written by the adapter (capture provenance)
```

---

## Public contract — `results.json` schema (semver-governed)

Version constant: `RESULTS_SCHEMA_VERSION` in `packages/witness/src/report/generator.ts`.

```json
{
  "version": "2.6.0",
  "timestamp": "<ISO>",
  "summary": { "total": 4, "passed": 1, "changed": 3, "newSnapshots": 0, "missing": 1 },
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
      "thumbPath":    "images/homepage/thumb.png",
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
    }
  ]
}
```

`thumbPath` (schema 2.6.0) is `images/<name>/thumb.png`, for a `changed` snapshot only
(never passed, auto-passed or new): the changed area of the baseline, the current capture
and the diff side by side, 2 px apart, at most 800×400 px, downscaled and never upscaled.
The area is the union of the up to three largest `regions` padded 24 px, or without regions
a 400 px band from the first differing row; on a size change it is on the padded canvas.
The HTML report does not show it; `publish@v1` puts it in the pull request comment.

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
`diffShape(...).kind !== "concentrated"`, within `noiseMaxDiffPercent`), and
`autoPassed` always comes with `status: "passed"`.

Breaking changes to this schema require a major version bump on `@testivai/witness`.

Exit codes (`packages/witness/src/commands/exit-codes.ts`): 0 pass / 1 changed / 2 new-only (gated by `--fail-on-diff`) / 3 missing-only (`failOnMissing` defaults **true**). Precedence: changed > missing > new.

---

## Versioning model

### npm packages — Changesets

```
contributor adds changeset → pnpm changeset
PR merges → CI opens "Version Packages" PR automatically
Version PR merges → CI publishes to npm with provenance
@testivai/mcp published → CI lists packages/mcp/server.json in the MCP Registry (mcp-registry.yml)
```

Independent versioning per package. Internal deps cascade at `patch` level.

### GitHub Action — semver tags

```
action/src/ changed → rebuild dist → cd action && pnpm run build
commit action/dist/ (index.js, review.cjs, publish.cjs)
push a new semver tag: git tag v1.x.y && git push origin v1.x.y
CI rolls the v1 major tag automatically
```

The `approve/`, `review/` and `publish/` composite actions load `action/dist/approve.cjs`, `action/dist/review.cjs` and `action/dist/publish.cjs`, so they ship with the dist at the same tag.

---

## PR conventions

| Convention | Rule |
|---|---|
| Branch prefix | `feat/`, `fix/`, `chore/`, `docs/` |
| Public API change | Must include `pnpm changeset` |
| Action src change | Must rebuild `action/dist/` and push a semver tag |
| Composite action change | No build step needed |
| Commit style | Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`) |
| Tests | `pnpm test` must pass; `pnpm e2e` must pass |
