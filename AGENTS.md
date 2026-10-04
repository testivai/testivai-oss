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
   The only exception is inside `action/` (the GitHub Action), which uses plain `npm`.

2. **Local-first, OSS-only.** There is no hosted service. Never reference a cloud
   product, dashboard, account, or API key in docs or code. AI explanation is
   bring-your-own-model via `@testivai/mcp` (`explain_snapshot`).
   Core vocabulary: pixel diff, DOM diff, noise hint, layered analysis, baselines, threshold.

3. **`action/dist/index.js` must always be committed.** After any change to `action/src/`,
   rebuild with `cd action && npm run build` and commit the updated `dist/index.js`.
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
  → @testivai/witness-playwright  captures screenshot + DOM snapshot
  → @testivai/witness BaselineStore
      first run  → writes .testivai/baselines/<name>/{screenshot.png, dom.html, metadata.json}
      later runs → writes .testivai/temp/<name>/...
                   pixel-diffs baseline vs temp
                   DOM-diffs baseline.dom.html vs temp.dom.html
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
      CI re-runs → passes
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
| `src/report/generator.ts` | Writes `results.json` + renders `index.html` |
| `src/report/template.ts` | Self-contained HTML template for the report |

### @testivai/witness-playwright (`packages/playwright/`)

| File | Responsibility |
|---|---|
| `src/snapshot.ts` | `witness()` entry point (`testivai.witness` and `snapshot` are kept as aliases) |
| `src/reporter.ts` | Playwright reporter — reads config, calls compare, generates report |

### @testivai/mcp (`packages/mcp/`)

| File | Responsibility |
|---|---|
| `src/server.ts` | Registers the tools and the `review-visual-changes` prompt; starts the stdio server on import |
| `src/tool-meta.ts` | Every tool's title and description (what the model reads before calling a tool) |
| `src/lib.ts` | `verdictFor()` one-line verdicts, `explainSnapshot()` evidence bundle, approve helpers (reuse witness BaselineStore) |

### GitHub Action reporter (`action/`)

| File | Responsibility |
|---|---|
| `src/index.ts` | Main: reads results.json, bundles pending-baselines, uploads artifact, posts comment |
| `src/comment.ts` | Builds PR comment markdown |
| `src/status.ts` | Determines pass/fail commit status |
| `src/types.ts` | Shared TypeScript interfaces |
| `dist/index.js` | Bundled output (esbuild) — **must be committed after every src change** |

### GitHub Action approver (`approve/`)

| File | Responsibility |
|---|---|
| `action.yml` | Composite action — no build step, ships as-is |

---

## On-disk contract — `.testivai/` directory

```
.testivai/
  config.json                    see LocalConfig in packages/witness/src/config/local-config.ts
  baselines/
    <name>/
      screenshot.png             committed reference screenshot
      dom.html                   committed DOM snapshot
      metadata.json              { name, timestamp, viewport, ... }
  temp/                          gitignored — current run artifacts
    <name>/
      screenshot.png
      dom.html
      metadata.json
```

---

## Public contract — `results.json` schema (semver-governed)

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
      "baselineApprovedAt": "<ISO>",
      "dom": {
        "changed":   false,
        "noiseHint": true,
        "summary":   null,
        "styleCheck":   "mismatch",
        "styleChanges": []
      },
      "regions":   [{ "x": 10, "y": 20, "width": 100, "height": 40,
                      "classification": "shift", "shift": { "dx": 0, "dy": -1 },
                      "elements": [{ "selector": ".hero > h1", "role": "shifted" }] }],
      "pageShift": { "dy": -1, "belowY": 120, "count": 4 },
      "masks": [], "maskWarnings": [],
      "autoPassed": "noise"
    }
  ]
}
```

Breaking changes to this schema require a major version bump on `@testivai/witness`.

Exit codes (`packages/witness/src/commands/exit-codes.ts`): 0 pass / 1 changed / 2 new-only (gated by `--fail-on-diff`) / 3 missing-only (`failOnMissing` defaults **true**). Precedence: changed > missing > new.

---

## Versioning model

### npm packages — Changesets

```
contributor adds changeset → pnpm changeset
PR merges → CI opens "Version Packages" PR automatically
Version PR merges → CI publishes to npm with provenance
```

Independent versioning per package. Internal deps cascade at `patch` level.

### GitHub Action — semver tags

```
action/src/ changed → rebuild dist → cd action && npm run build
commit dist/index.js
push a new semver tag: git tag v1.x.y && git push origin v1.x.y
CI rolls the v1 major tag automatically
```

The `approve/action.yml` composite action has no build step — it ships at the same `v1` tag automatically.

---

## PR conventions

| Convention | Rule |
|---|---|
| Branch prefix | `feat/`, `fix/`, `chore/`, `docs/` |
| Public API change | Must include `pnpm changeset` |
| Action src change | Must rebuild `action/dist/index.js` and push a semver tag |
| Composite action change | No build step needed |
| Commit style | Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`) |
| Tests | `pnpm test` must pass; `pnpm e2e` must pass |
