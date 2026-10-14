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

## AI triage of every diff

The reporter says *what kind* of change each snapshot is, deterministically.
The companion `testivai/testivai-oss/review@v1` action adds a second opinion
on every pull request run that has a changed or new snapshot: Claude
([`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action))
reads the report through [`@testivai/mcp`](./mcp.md), looks at the baseline,
current and diff images, reads the pull request's diff and description, and
sorts each snapshot into one of four verdicts:

| Verdict | Meaning |
|---|---|
| 🔴 bug | The page changed in a way the pull request did not mean to make, or the result looks broken |
| 🟠 possible bug | The page really changed, but the evidence cannot settle whether that was meant; the comment says what to check |
| 🟢 intended change | The page changed, and it matches what the pull request meant to do |
| ⚪ glitch | The page did not change: render noise, a bad capture (either one), or a resource that failed to load |

The rules are the MCP server's [`triage-visual-diff`](./mcp.md#triage-a-diff-glitch-intended-change-bug-or-possible-bug)
prompt, so an agent on your machine and CI judge the same way. A changed DOM
or changed computed styles is never a glitch, an identical DOM whose styles
were not compared is not called one from the DOM alone, and a large or local
diff is called a glitch only when nothing the pull request changed could have
caused it (the style check does not cover every CSS property).

The result is one PR comment, updated on each push:

| Snapshot | Verdict | Confidence | Evidence | Next step |
|---|---|---|---|---|
| `home` | 🔴 bug | high | DOM changed: `footer.site-footer` removed; the PR only touches `button.btn` in `site/styles.css`. | Restore the footer in `site/index.html`. |

It is advisory. It never changes the visual check or a baseline, and Claude
gets read-only tools: the TestivAI MCP tools without `approve_snapshot` and
`approve_all`, and file reads inside the workspace except `.git` (and nothing
under `/proc` or `/sys`). No commands, edits or network. Claude gets the job's
own `github.token`, never a token you pass as `github-token`. Tokens or keys
in its answer are redacted, and its text is posted with HTML, @mentions,
links and images defanged. Approving stays a human `/testivai approve <name>`.

### Setup

Add a repository secret, `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN`
(from `claude setup-token`, to use a Claude subscription), and a job after
your visual job:

```yaml
jobs:
  # ...your visual job (here `visual-regression`), with the
  # testivai/testivai-oss@v1 reporter step...

  ai-triage:
    name: AI triage
    needs: visual-regression
    # !cancelled(): a changed snapshot fails the visual job, which is exactly
    # when the triage is useful.
    if: ${{ !cancelled() && github.event_name == 'pull_request' }}
    # A newer push cancels the triage of an older one, and the tokens with it.
    concurrency:
      group: ai-triage-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read         # check out the code Claude may read
      pull-requests: write   # read the PR's diff, post the comment
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        # No artifact when the visual job failed before the tests ran: the
        # triage then skips with a warning instead of failing this job.
        continue-on-error: true
        with:
          name: testivai-visual-report   # the reporter's artifact-name
          path: visual-report            # the reportDir in .testivai/config.json
      - uses: testivai/testivai-oss/review@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # enabled: false   # turn it off: Claude does not run, no tokens are used
```

The action reads the report where the MCP server Claude uses reads it: the
`reportDir` in `.testivai/config.json`, else `visual-report`. Download the
artifact there.

The step can also go in the visual job itself, after the reporter, with
`if: ${{ !cancelled() }}`; a separate job keeps the Claude step away from that
job's write permissions.

### When it runs, and what it costs

It uses tokens only when **all** of these hold, and otherwise skips in
seconds:

1. `enabled` is not `false`.
2. The run is for a pull request (`pull_request` event).
3. At least one snapshot is changed or new. Passed snapshots and missing
   baselines alone never start a run and are not triaged (Claude still sees
   each passed snapshot as one line of `get_visual_results`).
4. A Claude credential is set. Pull requests from forks get no secrets, so
   they are skipped.
5. The run was not started by a bot, unless that bot is in `allowed-bots`
   (`claude-code-action` refuses other bots, so those runs skip with a notice).

Each triage is one Claude Code session that calls the MCP tools and looks at
images, so its cost grows with the number of changed snapshots. When we ran
the same prompt on one to three changed snapshots, one triage took about 60k
to 85k tokens (measured with Claude subagents, not inside the action, so
treat it as a rough guide and check your usage after the first runs).
`max-turns` caps a run (a run that hits the cap posts no triage and does not
fail the job), and `model` picks a smaller model.

To turn it off, set `enabled: false`: Claude does not start, and an earlier
triage comment on the PR is replaced with a note that the triage is off.
Removing the job also stops it, but leaves the last triage comment as it was.

The comment names the commit it triaged. A run that a newer push has
superseded never touches it, and the `concurrency` group above cancels such a
run early. A comment that cannot be written is a warning in the log, never a
failed job.

### Inputs

| Input | Default | Description |
|---|---|---|
| `anthropic-api-key` | `''` | Anthropic API key. Set this or `claude-code-oauth-token`; with neither, the triage is skipped with a notice |
| `claude-code-oauth-token` | `''` | Claude Code OAuth token (`claude setup-token`), to use a Claude subscription |
| `enabled` | `true` | `false` turns it off: Claude does not run and no tokens are used. Anything but `true`/`false` fails the step |
| `allowed-bots` | `''` | Bots whose pull request runs may be triaged (comma-separated, or `*`), passed to `claude-code-action`'s `allowed_bots` |
| `model` | `''` | Claude model, for example a smaller one to spend fewer tokens. Empty uses Claude Code's default |
| `max-turns` | `30` | Most agent turns Claude may take (1 to 200) |
| `github-token` | `${{ github.token }}` | Reads the PR diff and posts the comment; needs `pull-requests: write`. Claude itself always gets the job's own `github.token` |

The triage is a model's reading of deterministic evidence, and it can be
wrong. The pull request's description and diff and the page content reach the
model as data; a pull request that tries to talk the model into a verdict can
still mislead the comment, which is one more reason approving stays a human
decision.

## Caveats

- The Action assumes the local HTML report has already been generated by a framework adapter run. It does not run tests itself.
- Permissions: the workflow needs `pull-requests: write`, `statuses: write`, and `checks: write` (the last one for the non-blocking neutral result; without it the Action falls back to the commit status). The default `GITHUB_TOKEN` has these for non-fork PRs. The approve job needs `actions: read`, `contents: write` and `pull-requests: write` ([setup](#approve-job-setup)).
- **Fork pull requests**: GitHub gives workflows a read-only token for PRs from forks unless a repository admin enables *Send write tokens to workflows from pull requests*. Without that, comments, statuses and check runs all fail for outside contributors — this is a GitHub restriction, not a TestivAI one.

## See also

- [Action source + contributing](https://github.com/testivai/testivai-oss/tree/main/action)
- [Marketplace listing](https://github.com/marketplace/actions/testivai-visual-report)
- [`docs/extension-api.md`](./extension-api.md) — the `results.json` contract the Action consumes
