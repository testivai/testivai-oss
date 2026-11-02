# TestivAI Visual Report — GitHub Action

Posts TestivAI visual regression results from `results.json` to pull requests as a comment + commit status. Designed to consume the local-mode output of `@testivai/witness` and the framework adapters (`@testivai/witness-playwright`, `@testivai/witness-webdriverio`, …).

## Usage

```yaml
name: Visual Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test

      # Post results to PR (always runs so a failed test still gets a report)
      - uses: testivai/testivai-oss@v1
        if: ${{ !cancelled() }}   # after a failing test too
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          report-dir: visual-report
          fail-on-diff: false
```

Pin to `@v1` for rolling major-version updates, or `@v1.0.0` for a fixed point release.

## Inputs

| Input | Description | Required | Default |
|---|---|---|---|
| `github-token` | GitHub token for posting comments + commit status | Yes | `${{ github.token }}` |
| `report-dir` | Directory containing `results.json` and the rendered HTML report | Yes | `visual-report` |
| `fail-on-diff` | Fail workflow if visual changes detected | No | `false` |
| `fail-on-missing` | Fail workflow if a committed baseline received no capture this run | No | `false` |
| `upload-artifact` | Upload report as a workflow artifact | No | `true` |
| `artifact-retention-days` | Days to retain artifact | No | `30` |
| `artifact-name` | Name of the uploaded artifact | No | `testivai-visual-report` |
| `status-context` | Name of the commit status context; also namespaces the PR comment | No | `TestivAI / visual` |

When a repo runs more than one visual lane (e.g. a Playwright workflow and a pytest workflow), give each its own `status-context` (and `artifact-name`) so the second workflow doesn't overwrite the first's commit status and PR comment — each lane gets its own status entry and its own upserted comment.

## What it posts

- **PR comment** (upserted via `<!-- testivai-visual-report -->` marker; namespaced per `status-context` for non-default contexts) summarising passed / changed / new counts, with collapsed details for each changed snapshot and approval commands
- **Commit status** under the context `TestivAI / visual` (configurable via `status-context`) — `success`, `pending`, or `failure` based on `fail-on-diff` and `fail-on-missing`
- **Workflow artifact** of the entire `report-dir` (HTML report, `results.json`, diff images)

The comment links the report as that artifact, a ZIP. With the companion `testivai/testivai-oss/publish@v1` action, each run's report is published to the repository's GitHub Pages, and once it is, the comment links it (the ZIP stays as a fallback), and each changed or new snapshot links to its card in it: see [Reports on GitHub Pages](../docs/github-action.md#reports-on-github-pages).

The PR comment surfaces the **DOM noise hint** from the OSS `@testivai/witness` pixel-and-DOM comparison. The action does not filter on the hint: every snapshot with status `changed` is listed with its approve command. A diff becomes `passed` before it reaches the action only through witness pass criteria you configure (`maxDiffPercent`, `maxDiffPixels`, `shiftTolerance`, or `noiseAutoPass`, which passes an identical-DOM diff only when `styleCheck` is "match" and the diff is not concentrated in one area). When pixels differ but the DOM is structurally identical, the computed-style check decides what the comment says:

- **Styles compared and unchanged** (`styleCheck: "match"`), small and scattered diff: likely render noise (anti-aliasing, font hinting), still not proof. The line ends "Styles verified unchanged; the diff is small and scattered".
- **Styles compared and unchanged, but the diff is concentrated in one area** (every diff region fits in a box covering at most a third of the page) **or large** (over 1% of pixels): not called noise. The style check covers a fixed list of properties, so this is a bad capture or a change it does not cover (size, overflow, transform, images…). The comment names the regions and their box, and says to compare the images before approving.
- **Styles changed** (`styleCheck: "mismatch"`): a style-only change, which is real, not noise.
- **Styles not compared** (`styleCheck: "unavailable"`, or a `results.json` from before the style check): the comment says "DOM unchanged, styles not compared". It could be render noise or a stylesheet-only change, so compare the images before approving. This happens when there are no comparable style digests on both sides, for example when a capture has no element map.

When the DOM also differs, the comment summarises added / removed / attribute-change counts so reviewers can decide whether the change is intentional.

## Example output

```
### TestivAI Visual Report

**12 passed** | **3 changed** | **2 new**

#### Changed Snapshots
<details>
<summary>checkout-page — 0.5% different</summary>

> DOM unchanged — pixel diff is likely render noise (anti-aliasing, font hinting). Styles verified unchanged; the diff is small and scattered.

/testivai approve checkout-page
</details>

<details>
<summary>pricing — 0.3% different</summary>

> DOM unchanged, styles not compared — could be render noise or a stylesheet-only change (no comparable style digests on both sides). Compare the images before approving.

/testivai approve pricing
</details>

<details>
<summary>nav-redesign — 8.5% different</summary>

> DOM changed — 2 added, 1 attribute change.

/testivai approve nav-redesign
</details>
```

## Repository layout

Why `action.yml` is at the repo root and the rest is under `action/`:

| Path | What |
|---|---|
| `action.yml` (repo root) | Required by GitHub Marketplace — only root-level metadata files are auto-listed. |
| `action/src/`, `action/dist/`, `action/package.json`, `action/README.md`, `action/jest.config.js` | Source, build output, package config, and docs. Kept in a subdir so the workspace root stays SDK-focused. |

`action.yml`'s `runs.main:` resolves to `action/dist/index.js`. Consumers `uses: testivai/testivai-oss@v1` (no path).

The companion composite actions load their logic from the same `dist/`: `review/action.yml` (`testivai/testivai-oss/review@v1`, AI triage) runs `dist/review.cjs`, and `publish/action.yml` (`testivai/testivai-oss/publish@v1`, [reports on GitHub Pages](../docs/github-action.md#reports-on-github-pages)) runs `dist/publish.cjs`.

## Contributing

The action ships as a single bundled file at `action/dist/index.js` (built with `@vercel/ncc`). GitHub Actions runs that file directly from the consumer's checked-out source — there is no install step, no `npm install` at action-runtime — so **`dist/` must be committed** any time the source changes.

```bash
# From the repo root
pnpm --filter testivai-action run build
git add action/dist
git commit
```

CI guards this with a step that fails any PR where `action/dist/` is out of sync with `action/src/`. If your PR errors with “action/dist/ is out of sync with src/”, run the build above and commit the result.

## Releases

Tag a clean semver release and the [Release Action workflow](../.github/workflows/release-action.yml) automatically rolls the matching major-version tag (e.g. tagging `v1.2.3` updates the `v1` tag to point at the same SHA). Pre-release tags (`v1.0.0-rc.1`) are skipped — they don't move the stable major pointer.

GitHub refuses to move a tag onto a commit whose workflow files (`.github/workflows/`) changed since the tag's old commit unless the token has the `workflows` permission, and the workflow's built-in `GITHUB_TOKEN` cannot be given it. So the workflow pushes with the `RELEASE_TAG_TOKEN` repository secret when it is set:

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with access to this repository only, and the repository permissions **Contents: Read and write** and **Workflows: Read and write**. Its owner needs write access to the repository; give it an expiry and renew it.
2. Save it as the repository secret `RELEASE_TAG_TOKEN` (Settings → Secrets and variables → Actions).

Without the secret, the workflow uses the built-in token, which works only when no workflow file changed since the last release. When the push is refused, the job fails saying so, with the commands to move the major tag by hand; after adding or fixing the secret, re-run the job (or run the workflow by hand with the release tag).

### Releasing from your clone

`scripts/release-action.js` tags a release and moves the major tag with your own git credentials, so it works whatever the workflow's token can do. Use it as the release step, or when the workflow could not move the major tag:

```bash
node scripts/release-action.js v1.6.2 --dry-run   # check, change nothing
node scripts/release-action.js v1.6.2             # tag origin/main, move v1, check the remote
node scripts/release-action.js v1.6.1 --ref beb0eab   # an earlier commit of main; reuses an existing tag at it
```

It fetches `main` and the tags first, and refuses, changing nothing, when the version is not `vMAJOR.MINOR.PATCH`, is older than a release of the same major, or exists at another commit, or when the commit is not on `origin/main`, has no `action/dist/index.js`, or has no `## [X.Y.Z]` section in `action/CHANGELOG.md`. `--message` sets the release tag's message. The workflow still runs on the tag push and moves the major tag to the same commit (or fails harmlessly).

## License

MIT

## Links

- Repo: https://github.com/testivai/testivai-oss
- Issues: https://github.com/testivai/testivai-oss/issues
- Marketing: https://testiv.ai
