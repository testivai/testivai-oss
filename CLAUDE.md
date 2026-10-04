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
                                      CI re-runs → passes
```

## Key files per package

### @testivai/witness (`packages/witness/`)
- `src/baselines/store.ts`   — BaselineStore: read/write/approve/undo baselines and temp
- `src/diff/diff.ts`         — pixel comparison (pixelmatch-based)
- `src/diff/dom-diff.ts`     — zero-dep DOM tokenizer + multiset comparator; emits noiseHint
- `src/config/local-config.ts` — LocalConfig type + defaults (single source of truth for config.json fields)
- `src/report/compare.ts`    — orchestrates diff, writes images to visual-report/images/, applies pass criteria (maxDiffPercent/maxDiffPixels/noiseAutoPass → status passed + autoPassed marker)
- `src/report/generator.ts`  — writes results.json + renders index.html
- `src/report/template.ts`   — HTML template for the report

### @testivai/witness-playwright (`packages/playwright/`)
- `src/snapshot.ts`          — `witness()` entry point (stabilizes page, applies ignoreSelectors, captures); `testivai.witness` and `snapshot` are kept as aliases
- `src/config/stabilize.ts`  — capture stabilization CSS + resolution (per-call > project > config.json > default true)
- `src/reporter.ts`          — Playwright reporter (reads config, calls compare, generates report)

### @testivai/mcp (`packages/mcp/`)
- `src/server.ts`            — registers the tools and the `review-visual-changes` prompt; starts the stdio server on import
- `src/tool-meta.ts`         — every tool's title and description (what the model reads before calling a tool)
- `src/lib.ts`               — `verdictFor()` one-line verdicts, `explainSnapshot()` evidence bundle, approve helpers (reuse witness BaselineStore)

### GitHub Action reporter (`action/`)
- `src/index.ts`             — main entry: reads results.json, bundles pending-baselines, uploads artifact, posts PR comment + commit status
- `src/comment.ts`           — builds PR comment markdown (with DOM noise hint)
- `src/status.ts`            — determines pass/fail commit status
- `src/types.ts`             — shared TypeScript interfaces
- `dist/index.js`            — bundled output (esbuild); **must be committed**; rebuild with `npm run build` inside `action/`

### GitHub Action approver (`approve/`)
- `action.yml`               — composite action; no build step needed (pure shell + github-script)

## Changesets (versioning + publishing)

- Each PR that changes public API must include a changeset: `pnpm changeset`
- Changeset files live in `.changeset/*.md`
- On merge to main, the release workflow opens a "Version Packages" PR automatically
- Merging the Version PR triggers `pnpm release` (publish to npm with provenance)
- Independent versioning: each package has its own version; `updateInternalDependencies: "patch"` cascades

## Action versioning

The GitHub Action (`action.yml` at repo root → `action/dist/index.js`) uses a separate versioning scheme from the npm packages:
- Semver tags like `v1.0.2` are for the action
- The `v1` major tag is rolled automatically by `.github/workflows/release-action.yml` on every clean semver tag push
- After any change to `action/src/`, rebuild dist AND push a new semver tag to roll `v1`

The approve action (`approve/action.yml`) is a composite action — no build step, no dist. It ships automatically at the same `v1` tag.

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
  "version": "2.3.0",
  "timestamp": "<ISO>",
  "summary": { "total": 3, "passed": 0, "changed": 3, "newSnapshots": 0, "missing": 1 },
  "missingBaselines": ["pricing"],
  "snapshots": [
    {
      "name": "homepage",
      "status": "changed",
      "diffPercent": 12.34,
      "baselinePath": "images/homepage/baseline.png",
      "currentPath":  "images/homepage/current.png",
      "diffPath":     "images/homepage/diff.png",
      "baselineApprovedAt": "<ISO>",  // when the baseline was last approved
      "dom": {
        "changed":   false,
        "noiseHint": true,
        "summary":   null,
        "styleCheck":   "mismatch",   // "match" | "mismatch" | "unavailable"
        "styleChanges": []
      },
      "regions": [                    // pixel clusters attributed to elements
        {
          "x": 10, "y": 20, "width": 100, "height": 40,
          "classification": "shift",  // "shift" | "change"
          "shift": { "dx": 0, "dy": -1 },
          "elements": [{ "selector": ".hero > h1", "role": "shifted" }]
        }
      ],
      "pageShift": { "dy": -1, "belowY": 120, "count": 4 },
      "masks": [], "maskWarnings": [],
      "autoPassed": "noise"   // optional; "threshold" | "noise" | "shift" when a
                              // pass criterion turned a pixel diff into status passed
    }
  ]
}
```

Exit-code contract (`packages/witness/src/commands/exit-codes.ts`): 0 pass / 1 changed / 2 new-only (gated by `--fail-on-diff`) / 3 missing-only (`failOnMissing` defaults **true**; escape with config `false` or `--allow-missing`). Precedence: changed > missing > new.

## Terminology

- Core vocabulary: pixel diff, DOM diff, noise hint, layered analysis, baselines, threshold, heatmap.
- TestivAI is **local-first and OSS-only** — there is no hosted service. Never reference a cloud product, dashboard, account, or API key in docs or code; AI-powered explanation is bring-your-own-model via `@testivai/mcp` (`explain_snapshot`). See `docs/philosophy.md`.

## PR conventions

- Branch names: `feat/`, `fix/`, `chore/`, `docs/`
- Every public API change needs a changeset (`pnpm changeset`)
- `action/dist/index.js` must always be committed — CI verifies this
- Composite actions (`approve/action.yml`) need no build step
