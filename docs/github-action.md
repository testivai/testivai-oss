---
sidebar_position: 5
title: GitHub Action
---

# GitHub Action

`testivai/testivai-oss@v1` is a GitHub Action that reads the local visual report (`results.json` + assets) and posts it to pull requests as a comment + commit status. Designed to run after any framework adapter — Playwright, WebdriverIO, or future ones — finishes producing a `visual-report/` directory.

## Quick start

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

      # Post results to the PR. `if: always()` so a failed test still
      # produces a report comment.
      - uses: testivai/testivai-oss@v1
        if: always()
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
| `fail-on-diff` | Fail the workflow when visual changes are detected | No | `false` |
| `upload-artifact` | Upload the report directory as a workflow artifact | No | `true` |
| `artifact-retention-days` | Days to retain the artifact | No | `30` |
| `artifact-name` | Name of the uploaded artifact | No | `testivai-visual-report` |
| `status-context` | Name of the commit status context; also namespaces the PR comment | No | `TestivAI / visual` |

### Multiple visual lanes in one repo

When a repo runs more than one visual workflow (say, a TypeScript Playwright lane and a Python pytest lane), give each workflow its own `status-context` (and `artifact-name`). Each lane then posts its own commit status and upserts its own PR comment instead of overwriting the other's:

```yaml
- uses: testivai/testivai-oss@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    report-dir: visual-report
    status-context: 'TestivAI / visual (pytest)'
    artifact-name: testivai-visual-report-pytest
```

Requires `testivai/testivai-oss@v1` ≥ v1.0.10.

## What the Action posts

### Check run — visible without blocking

A check run whose conclusion reflects what actually needs to happen:

| Situation | Conclusion | Blocks the merge? |
|---|---|---|
| Nothing changed | `success` | no |
| Snapshots changed or new, `fail-on-diff: false` (default) | **`neutral`** | **no** |
| Baselines received no capture, `fail-on-missing: false` (default) | **`neutral`** | **no** |
| Snapshots changed and `fail-on-diff: true` | `failure` | yes |
| Baselines uncovered and `fail-on-missing: true` | `failure` | yes |

`neutral` is the important one. GitHub's branch protection documentation states
that *"required status checks must have a successful, skipped, or neutral status
before collaborators can make changes to a protected branch"* — so a neutral
result is fully visible in the PR and never blocks a merge, even when the check
is marked required.

This replaces reporting **`success`** for a run with changes, which is what the
Action used to do. A green tick that means "please review this" is a green tick
people stop reading.

:::note Needs `checks: write`
Check runs are a different API from commit statuses. Add it to the workflow:

```yaml
permissions:
  contents: read
  pull-requests: write
  statuses: write
  checks: write        # for the non-blocking neutral result
```

Without it the Action logs a warning and falls back to the commit status alone —
nothing breaks, you just lose `neutral` and a review-needed run shows green.
:::

The commit status is still posted alongside, so existing branch-protection rules
that reference it keep working.

### PR comment (upserted)

A single comment per PR (identified by the `<!-- testivai-visual-report -->` marker; namespaced per `status-context` when a non-default context is set) with a passed / changed / new summary. Each changed snapshot gets a collapsed `<details>` with the diff percent, the DOM noise hint (when applicable), and the approval CLI command:

```
### TestivAI Visual Report

**12 passed** | **3 changed** | **2 new**

#### Changed Snapshots
<details>
<summary>checkout-page — 0.5% different</summary>

> DOM unchanged — pixel diff is likely render noise (anti-aliasing, font hinting). Styles verified unchanged.

/testivai approve checkout-page
</details>

<details>
<summary>landing — 0.3% different</summary>

> **DOM unchanged, styles not compared** — could be render noise or a stylesheet-only change (no comparable style digests on both sides). Compare the images before approving.

/testivai approve landing
</details>

<details>
<summary>nav-redesign — 8.5% different</summary>

> DOM changed — 2 added, 1 attribute change.

/testivai approve nav-redesign
</details>
```

The DOM noise hint is the same signal the local HTML report shows. When the underlying DOM is structurally identical to baseline and the computed styles were compared and match, the comment says "likely render noise" (likely, not proven) so reviewers can triage it faster. When only the computed styles changed, it flags a style-only change, which is real. When the DOM is identical but the styles were not compared (no comparable style digests on both sides, as with `testivai witness <url>` captures), it says **DOM unchanged, styles not compared**: render noise and a stylesheet-only change are both still possible, so compare the images before approving. When the DOM also differs, it shows added / removed / attribute-change counts.

### Commit status

A status under the context `TestivAI / visual` (configurable via `status-context`) is set on the head SHA. Default behavior:

| Snapshot state | `fail-on-diff: true` | `fail-on-diff: false` (default) |
|---|---|---|
| All passed | success | success |
| Changes present | failure | success (with note "non-blocking") |
| New snapshots only | success | success |

### Workflow artifact

Whole `report-dir/` (HTML report, `results.json`, all diff images and DOM captures) uploaded as a workflow artifact named `testivai-visual-report`. Useful for downloading and inspecting the rendered report from a failed run.

## Approving changes from PR feedback

The fastest path is the comment command: post `/testivai approve <name>` (or `/testivai approve --all`) directly on the PR. The companion `testivai/testivai-oss/approve@v1` action verifies the commenter has write access, restores the pending baselines from the workflow artifact, and commits them back to the PR branch — no local checkout needed.

### Approve job setup

Add a job that runs on PR comments. `issue_comment` workflows run from the
default branch, so the job only answers comments once it is merged there.

```yaml
on:
  pull_request:
  issue_comment:
    types: [created]

jobs:
  # ...your visual job, with the testivai/testivai-oss@v1 reporter step...

  approve-baselines:
    if: |
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request != null &&
      startsWith(github.event.comment.body, '/testivai')
    runs-on: ubuntu-latest
    permissions:
      actions: read          # find the visual run and download its report artifact
      contents: write        # commit the baselines to the PR branch
      pull-requests: write   # reply on the PR
    steps:
      - uses: testivai/testivai-oss/approve@v1
        with:
          github-token: ${{ secrets.TESTIVAI_APPROVE_TOKEN || secrets.GITHUB_TOKEN }}
          workflow: visual.yml   # the file that runs the visual tests
```

Without `actions: read`, an explicit `permissions:` block denies the Actions
API and the job fails with `HTTP 403: Resource not accessible by integration`.

### Approve with a token that re-runs CI

GitHub starts no workflow run for a push made with `GITHUB_TOKEN`. With the
default token, approve commits the baselines but the PR's visual check stays
as it was until the next push. To have CI run again on the approve commit,
create a fine-grained personal access token limited to the repository, with
repository permissions **Contents: read and write**, **Pull requests: read
and write** and **Actions: read**, and save it as a repository secret
(`TESTIVAI_APPROVE_TOKEN` above). The commit is still authored as
`github-actions[bot]`, but it is pushed, and the reply posted, as the token's
owner. A GitHub App installation token with the same permissions works too.
When the secret is not set, the `||` falls back to `GITHUB_TOKEN`.

### Approve locally

Alternatively, approve locally on the PR branch, commit the updated baselines, and push:

```bash
# On the PR branch, regenerate captures
npx playwright test

# Approve the change
npx testivai approve "checkout-page"

# Commit the new baseline
git add .testivai/baselines
git commit -m "approve: checkout-page redesign"
git push
```

The next CI run shows the snapshot back in the `passed` bucket. Approve everything at once with `npx testivai approve --all`; undo with `npx testivai approve --undo "checkout-page"`.

## Caveats

- The Action assumes the local HTML report has already been generated by a framework adapter run. It does not run tests itself.
- Permissions: the workflow needs `pull-requests: write`, `statuses: write`, and `checks: write` (the last one for the non-blocking neutral result; without it the Action falls back to the commit status). The default `GITHUB_TOKEN` has these for non-fork PRs. The approve job needs `actions: read`, `contents: write` and `pull-requests: write` ([setup](#approve-job-setup)).
- **Fork pull requests**: GitHub gives workflows a read-only token for PRs from forks unless a repository admin enables *Send write tokens to workflows from pull requests*. Without that, comments, statuses and check runs all fail for outside contributors — this is a GitHub restriction, not a TestivAI one.

## See also

- [Action source + contributing](https://github.com/testivai/testivai-oss/tree/main/action)
- [Marketplace listing](https://github.com/marketplace/actions/testivai-visual-report)
- [`docs/extension-api.md`](./extension-api.md) — the `results.json` contract the Action consumes
