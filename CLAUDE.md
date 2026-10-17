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
- `src/report/diff-shape.ts` — `diffShape()`: scattered / concentrated / large, the rule for when matching styles still mean likely render noise (shared by compare, the report, MCP and the action)
- `src/report/compare.ts`    — orchestrates diff, writes images to visual-report/images/, applies pass criteria (maxDiffPercent/maxDiffPixels/noiseAutoPass → status passed + autoPassed marker)
- `src/report/generator.ts`  — writes results.json + renders index.html
- `src/report/template.ts`   — HTML template for the report

### @testivai/witness-playwright (`packages/playwright/`)
- `src/snapshot.ts`          — `witness()` entry point (stabilizes page, applies ignoreSelectors, captures); `testivai.witness` and `snapshot` are kept as aliases
- `src/config/stabilize.ts`  — capture stabilization CSS + resolution (per-call > project > config.json > default true)
- `src/reporter.ts`          — Playwright reporter (reads config, calls compare, generates report)

### @testivai/mcp (`packages/mcp/`)
- `src/server.ts`            — registers the tools and the `review-visual-changes` and `triage-visual-diff` prompts; starts the stdio server on import
- `src/tool-meta.ts`         — every tool's title and description (what the model reads before calling a tool), and the prompt texts; `TRIAGE_PROMPT.rubric()` is shared with the review action
- `src/lib.ts`               — `verdictFor()` one-line verdicts, `explainSnapshot()` evidence bundle, approve helpers (reuse witness BaselineStore)

### GitHub Action reporter (`action/`)
- `src/index.ts`             — main entry: reads results.json, bundles pending-baselines, uploads artifact, posts PR comment + commit status
- `src/comment.ts`           — builds PR comment markdown (with DOM noise hint)
- `src/status.ts`            — determines pass/fail commit status
- `src/types.ts`             — shared TypeScript interfaces
- `src/review.ts`            — the review action's logic: when it runs, the triage prompt (MCP rubric), Claude's tools and output schema, the comment
- `dist/index.js`, `dist/review.cjs` — bundled output (esbuild); **must be committed**; rebuild with `npm run build` inside `action/`

### GitHub Action AI triage (`review/`)
- `action.yml`               — composite action: github-script prepare → `anthropics/claude-code-action@v1` → github-script post; loads `action/dist/review.cjs`, so it ships with the action's dist at the same `v1` tag

### GitHub Action approver (`approve/`)
- `action.yml`               — composite action; no build step needed (pure shell + github-script)

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

The approve action (`approve/action.yml`) is a composite action — no build step, no dist. It ships automatically at the same `v1` tag. The review action (`review/action.yml`) is composite too, but its logic is `action/dist/review.cjs`: rebuild the dist after changing `action/src/review.ts` (or the MCP triage rubric it bundles).

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
                                         shareUploadCommand, mcpApprovalPrompt
  baselines/
    <snapshot-name>/
      screenshot.png                   — committed reference screenshot
      dom.html                         — committed DOM snapshot
      metadata.json                    — { name, timestamp, viewport, ... }
  temp/
    <snapshot-name>/
      screenshot.png                   — current run screenshot (gitignored)
      dom.html
      metadata.json
```

`temp/` is gitignored. The `approve` action copies `temp/<name>/` → `baselines/<name>/` to update a baseline.

## results.json schema (public contract, semver-governed)

Version constant: `RESULTS_SCHEMA_VERSION` in `packages/witness/src/report/generator.ts`.

```json
{
  "version": "2.4.0",
  "timestamp": "<ISO>",
  "summary": { "total": 3, "passed": 1, "changed": 2, "newSnapshots": 0, "missing": 1 },
  "missingBaselines": ["pricing"],
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
    }
  ]
}
```

`sizeMismatch` (schema 2.4.0) is present when the current capture's dimensions differ
from the baseline's. The two are padded to max width × max height before diffing and
every padded pixel counts as changed, so `totalPixels`, `diffCount` and `regions` are on
that canvas and the snapshot is never `passed`: no pass criterion applies to a snapshot
with `sizeMismatch`, nor to one with `dom.changed: true`, even at `diffCount: 0`. A
height change is content added or removed (read it with `dom.summary`); a width change
is almost always the viewport or device scale factor, not the page: word it that way
(`describeSizeChange` / `formatSizeMismatch` in `packages/witness/src/report/size-mismatch.ts`,
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

Exit-code contract (`packages/witness/src/commands/exit-codes.ts`): 0 pass / 1 changed / 2 new-only (gated by `--fail-on-diff`) / 3 missing-only (`failOnMissing` defaults **true**; escape with config `false` or `--allow-missing`). Precedence: changed > missing > new.

## Terminology

- Core vocabulary: pixel diff, DOM diff, noise hint, layered analysis, baselines, threshold, heatmap.
- TestivAI is **local-first and OSS-only** — there is no hosted service. Never reference a cloud product, dashboard, account, or API key in docs or code; AI-powered explanation is bring-your-own-model via `@testivai/mcp` (`explain_snapshot`). See `docs/philosophy.md`.

## PR conventions

- Branch names: `feat/`, `fix/`, `chore/`, `docs/`
- Every public API change needs a changeset (`pnpm changeset`)
- `action/dist/index.js` must always be committed — CI verifies this
- Composite actions (`approve/action.yml`) need no build step
