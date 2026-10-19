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
| `fail-on-missing` | Fail the workflow when a committed baseline received no capture this run (silent coverage loss) | No | `false` |
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
| Snapshots changed and `fail-on-diff: true`, even when baselines received no capture in the same run | `failure` | yes |

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

> DOM unchanged — pixel diff is likely render noise (anti-aliasing, font hinting). Styles verified unchanged; the diff is small and scattered.

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

The DOM noise hint is the same signal the local HTML report shows. When the underlying DOM is structurally identical to baseline, the computed styles were compared and match, and the diff is small and scattered, the comment says "likely render noise" (likely, not proven) so reviewers can triage it faster. When the DOM and styles match but the diff is concentrated in one area or over 1% of pixels, it says **DOM and styles unchanged, but the diff is concentrated in one area** (or **is large**): a bad capture, or a change the style check does not cover (size, overflow, transform, images…), so compare the images before approving. When only the computed styles changed, it flags a style-only change, which is real. When the DOM is identical but the styles were not compared (no comparable style digests on both sides, as with `testivai witness <url>` captures), it says **DOM unchanged, styles not compared**: render noise and a stylesheet-only change are both still possible, so compare the images before approving. When the DOM also differs, it shows added / removed / attribute-change counts.

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

Its reply lists what was approved and names the CI run the captures came from.
When [`publish@v1`](#reports-on-github-pages) has put that run's report on
GitHub Pages, the reply also links the report and each approved snapshot's
card in it. That link is taken from the TestivAI comment, where publish adds
it after the deploy for that exact run, so a run whose report is not
published yet gets a reply without it.

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

The token also lets [the reports on GitHub Pages](#reports-on-github-pages)
follow an approve. GitHub starts no `workflow_run` for a run that
`GITHUB_TOKEN` started, so with the default token the publish does not run
after the visual check on the approve commit: that run's report is not
published, and its comment gets no report link, until the next publish.

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
on every pull request run that has a changed or new snapshot or a missing
baseline: Claude
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

A missing baseline is a committed baseline that got no capture this run
(`missingBaselines` in `results.json`): its test was removed, renamed or
skipped, or failed before `witness()` captured. There is no current image and
the report cannot say why, so Claude reads the pull request. A removal or
rename it meant is an intended change. One it did not mean (a rename shows up
as a new snapshot under the other name), or a change that broke what the test
needs to reach its capture (the page, a selector it waits for), is a bug.
Anything else is a possible bug, with a pointer to the test run's log for a
failed or skipped test. It is never a glitch: there is no capture to call bad.
Approving does nothing for a missing baseline, because `/testivai approve`
only promotes a new capture: to accept an intended removal, delete the
baseline in the same pull request, for example
`git rm -r .testivai/baselines/<name>`. The prompt tells Claude where the
committed baseline is, so it can look at its `screenshot.png` even with an
older `@testivai/mcp` (the action runs the latest published one) that does not
list missing baselines yet.

The result is one PR comment, updated on each push:

| Snapshot | Verdict | Confidence | Evidence | Next step |
|---|---|---|---|---|
| `home` | 🔴 bug | high | DOM changed: `footer.site-footer` removed; the PR only touches `button.btn` in `site/styles.css`. | Restore the footer in `site/index.html`. |
| `products` (missing) | 🟢 intended change | high | No capture this run; the PR deletes `tests/products.spec.ts` and says the page is gone. | Delete its baseline in this PR: `git rm -r .testivai/baselines/products`. |

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

**Re-runs.** A re-run uploads the report again under the same name, and
artifact IDs are not in upload order, while `actions/download-artifact` takes
the highest ID among same-named artifacts. So on a re-run the reporter first
deletes the earlier attempts' report (a failed delete only warns), and it
writes the run and attempt next to `results.json` (`testivai-run.json`). If
this job still gets an earlier attempt's report, the triage is skipped with a
warning instead of describing results the run no longer has. The approve
action picks the newest report by creation time.

### When it runs, and what it costs

It uses tokens only when **all** of these hold, and otherwise skips in
seconds:

1. `enabled` is not `false`.
2. The run is for a pull request (`pull_request` event).
3. At least one snapshot is changed or new, or a baseline is missing
   (`missingBaselines` in `results.json`: committed, but no capture this
   run). Passed snapshots alone never start a run (Claude still sees each
   passed snapshot as one line of `get_visual_results`).
4. A Claude credential is set. Pull requests from forks get no secrets, so
   they are skipped.
5. The run was not started by a bot, unless that bot is in `allowed-bots`
   (`claude-code-action` refuses other bots, so those runs skip with a notice).

Runs that leave baselines out on purpose, such as a `--grep` run, one browser
lane of a matrix, a path-filtered job or one that passes `--allow-missing`,
always have missing baselines, so each pull request would start a triage with
a possible-bug row for every skipped baseline. Setting `failOnMissing: false`
in `.testivai/config.json` says missing baselines are expected and leaves
missing baselines out of the triage (changed and new snapshots are still
triaged). The `--allow-missing` flag and the reporter's `fail-on-missing`
input are not visible to the triage, so with those, run the triage only after
the job that captures the whole suite, or set `enabled: false`.

Each triage is one Claude Code session that calls the MCP tools and looks at
images, so its cost grows with the number of changed, new and missing snapshots. When we ran
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

## Reports on GitHub Pages

The reporter's comment links the report as a ZIP: download it, unzip it, open
`index.html`. The companion `testivai/testivai-oss/publish@v1` action puts
each run's report on the repository's GitHub Pages site instead, so the
comment links straight to it, and each changed or new snapshot's row links to
its card in the report:

> **[Open the visual report](https://example.github.io/my-app/pr/14/39150236166-1/)** — baseline, current and diff side by side · or [download it as a ZIP](https://github.com/example/my-app/actions/runs/39150236166/artifacts/4402)

The site holds the last 3 runs of each open pull request, forks included, at
`pr/<number>/<run id>-<attempt>/`, and the latest run on the default branch at
`main/`: the state pull requests merge into. Its front page lists them, each
pull request has a page of its runs, and a link to a report that is no longer
published explains why. The site is rebuilt from scratch on every publish
from what is true then, so a closed pull request's reports go with the next
publish, and nothing needs cleaning up.

**It replaces the repository's whole GitHub Pages site.** GitHub gives a
repository one site, and each publish deploys a new one. Use it in a
repository whose Pages site is free for it, not one that serves your docs.

### Who can open the reports

That is GitHub's setting, which only repository admins can change; the action
reads it and never changes it. It publishes only where Pages is on with
Settings → Pages → Source set to **GitHub Actions**; otherwise it publishes
nothing, says why in the job log, and the comment keeps the ZIP link.

| Repository | Pages site | What happens |
|---|---|---|
| public | public | Published. Anyone with the link can open it; pages ask search engines not to index them. |
| private or internal | private (GitHub Enterprise Cloud: Settings → Pages → Visibility) | Published. Only people who can read the repository can open it. |
| private or internal | public (every other plan) | **Not published**, unless `TESTIVAI_PUBLIC_REPORTS` is `true`. |

A public site would put a private repository's screenshots on the open
internet, so that case needs a yes: the variable `TESTIVAI_PUBLIC_REPORTS` set
to `true`. Set it on the `github-pages` environment (Settings → Environments →
github-pages), which only admins can configure. GitHub also reads a
repository or organization variable of that name when the environment has
none, and on an organization repository people with write access can create
repository variables. So it guards against publishing by accident; it is not
an access control (anyone with write access can already read, and copy, the
code).

### Setup

1. An admin sets Settings → Pages → Source to **GitHub Actions**.
2. Add a workflow; `workflows:` names your visual test workflow (the one with
   the `testivai/testivai-oss@v1` reporter step), by its `name:`:

```yaml
# .github/workflows/testivai-pages.yml
name: TestivAI reports

on:
  workflow_run:
    workflows: [TestivAI OSS]
    types: [completed]
  # Takes a closed pull request's reports off the site right away
  # (the next publish would anyway). Runs the action from the default
  # branch; it never checks out the pull request.
  pull_request_target:
    types: [closed]
  workflow_dispatch:

# Each publish builds the whole site: a newer one replaces a running one.
concurrency:
  group: testivai-pages
  cancel-in-progress: true

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read          # runs and their report artifacts
      pages: write           # deploy
      id-token: write        # deploy
      pull-requests: write   # the report links in comments
    environment:
      name: github-pages
      url: ${{ steps.publish.outputs.page-url }}
    steps:
      - id: publish
        uses: testivai/testivai-oss/publish@v1
        with:
          public-reports: ${{ vars.TESTIVAI_PUBLIC_REPORTS }}
```

`workflow_run` starts only from a workflow file on the default branch, so the
publish runs once this is merged. It runs after every visual run, whichever
branch or fork it came from, and that run's report is on the site a minute or
two after the reporter's comment.

After the deploy, the action adds the links to the TestivAI comment of each
pull request whose latest published run it describes; a comment already about
a newer run is left for that run's publish. A fork's CI run cannot comment
(its token is read-only), so on a fork's pull request the action posts a
comment of its own with the link, the run and the counts.

### Inputs

| Input | Default | |
|---|---|---|
| `public-reports` | `''` | Pass `${{ vars.TESTIVAI_PUBLIC_REPORTS }}` ([who can open the reports](#who-can-open-the-reports)). |
| `runs-per-pr` | `3` | How many of each open pull request's latest runs to publish, 1 to 10. Every publish downloads them all again: lower it for a repository with many open pull requests. |
| `artifact-name` | `testivai-visual-report` | The reporter's `artifact-name`. |
| `status-context` | `''` | The reporter's `status-context`, if you set one, so the links go into that lane's comment. |
| `comment` | `true` | `false` leaves comments alone. |
| `include-dir` | `''` | A folder of your own pages to publish with the reports ([below](#pages-of-your-own-on-the-same-site)). |
| `include-name` | `''` | The folder `include-dir` goes in on the site, such as `demo`. Required with `include-dir`. |
| `github-token` | `github.token` | Reads runs, artifacts and Pages settings, and writes the comments. The deploy always uses the job's own token. |

### Pages of your own on the same site

Since each publish replaces the whole site, pages you want on it too (a demo,
a landing page) go through the action: build them in an earlier step, from
the default branch, and pass the folder as `include-dir`. They are published
as they are under `include-name/` and linked from the front page; symbolic
links in the folder are skipped, and its size counts toward the site's.

Build them from the repository's own code only. `actions/checkout` without
`ref:` checks out the default branch on `workflow_run`, and the pull
request's base branch on `pull_request_target`, never the pull request
itself: never point it at the pull request's head, or a fork's code would run
with this job's token.

```yaml
# .github/workflows/testivai-pages.yml
name: TestivAI reports

on:
  workflow_run:
    workflows: [Visual Regression]
    types: [completed]
  pull_request_target:
    types: [closed]
  workflow_dispatch:

concurrency:
  group: testivai-pages
  cancel-in-progress: true

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
      pages: write
      id-token: write
      pull-requests: write
    environment:
      name: github-pages
      url: ${{ steps.publish.outputs.page-url }}
    steps:
      # The default branch, never the pull request.
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: '24', cache: 'npm' }
      - run: npm ci
      - run: npm run build:demo   # writes demo/ from the default branch
      - id: publish
        uses: testivai/testivai-oss/publish@v1
        with:
          public-reports: ${{ vars.TESTIVAI_PUBLIC_REPORTS }}
          include-dir: demo
          include-name: demo
```

### What gets published, and what does not

A pull request's CI run, a fork's included, decides what its report artifact
holds. So a page is never the artifact's own `index.html`: the action reads
only `results.json` and the report's PNGs, and rebuilds the page with the
report template.

- `results.json` is checked field by field (types, known values, sizes); a
  report it cannot show gets a page that says why, with links to the run and
  its ZIP. Every value on the page is escaped.
- An image is published only if it is a PNG of sane dimensions, at a numbered
  path (`images/<n>/current.png`), never under a snapshot's name. Others are
  left out, and the page says which.
- The ZIP is inflated in slices with limits (50 MB per image, 400 MB per
  report) and refused as soon as it goes over one, so a crafted archive
  cannot exhaust the runner.
- Every page carries a content security policy: its own inline styles and
  scripts and its own images, nothing loaded from or sent to another site.
  Project sites on `<owner>.github.io` share one origin, so this keeps one
  report from reaching another site's data even if markup ever got through
  the escaping.
- A fork's pages and the bot's comment on its pull request say the report
  comes from a fork; that comment holds numbers and links only, no text from
  the fork's results.
- The action never checks out or runs code from the pull request.

### Limits

- The last 3 runs per open pull request (`runs-per-pr`), and the latest run on
  the default branch. A report goes once its artifact expires (the reporter's
  `artifact-retention-days`).
- A pull request's runs are the ones on its branch since it was opened. A
  pull request opened from a branch name an earlier one used does not show
  the earlier one's reports.
- A run's report ZIP over 150 MB is not published, and the site stays under
  900 MB (GitHub Pages allows 1 GB): when it would be over, older runs go
  first, a fork's before a branch's, and each pull request's latest run last.
  The pull request's page lists what was left out and why.
- Only the 1000 newest report artifacts are read: a pull request whose last
  report is older than those is not published.
- Each publish downloads every published report again. With the default
  `GITHUB_TOKEN` (1,000 API requests an hour per repository), that is plenty
  for a few dozen open pull requests; lower `runs-per-pr` beyond that.
- A run that `GITHUB_TOKEN` started gets no publish: GitHub starts no
  `workflow_run` for it. That includes the visual check on a
  `/testivai approve` commit pushed with the default token, so that run's
  report is not published, and its comment gets no report link, until the
  next publish (the pull request's next push, or any other run that
  publishes). The approve reply still links the approved run's report,
  published before the approve. [An approve token](#approve-with-a-token-that-re-runs-ci)
  avoids it: the approve push then starts the pull request's workflow as the
  token's owner, and the publish follows.

#### Unreleased: reports reused between publishes

On `main`, not yet in a `publish@v1` release. Once released, this replaces
the "downloads every published report again" limit above.

- Each publish downloads only the runs it has not built before; the rest come
  from the Actions cache. A run's report never changes (a re-run uploads a new
  artifact), so each report ZIP a publish downloads is kept by artifact id in a
  folder that `actions/cache` restores before the build and saves after it,
  under a key per run (the newest one is restored next time). A publish that
  downloaded nothing new saves nothing, and a report no longer published leaves
  the cache with the next publish, so it holds one site's reports at most. The
  job log says how many reports were downloaded, and how many megabytes, and
  how many came from the cache.
- Nothing from the cache is trusted. A ZIP from it is used only when its
  SHA-256 is the digest GitHub lists for the artifact; anything else in the
  folder is downloaded again. Every page is still rebuilt from its report, with
  the same checks as a download, so the site is byte for byte the one a
  publish without the cache builds. An artifact without a digest (uploaded with
  `upload-artifact` older than v4) is downloaded every time.
- A cache that cannot be restored or saved never fails the publish. GitHub
  gives `pull_request_target` runs, and `workflow_run` runs a fork's pull
  request started, a read-only cache: those publishes read it and save nothing.
- `actions/cache` unpacks an entry before the action checks it, and a workflow
  on the default branch that GitHub gives a writable cache (one a push, schedule
  or `workflow_dispatch` starts) can save one under any key. If code you do not
  trust can run in such a workflow, set `cache: false` (input below): every
  publish then downloads every report, as before.

| Input | Default | |
|---|---|---|
| `cache` | `true` | `false` downloads every report on every publish, and neither reads nor writes the Actions cache. |

## Caveats

- The Action assumes the local HTML report has already been generated by a framework adapter run. It does not run tests itself.
- Permissions: the workflow needs `pull-requests: write`, `statuses: write`, and `checks: write` (the last one for the non-blocking neutral result; without it the Action falls back to the commit status). The default `GITHUB_TOKEN` has these for non-fork PRs. The approve job needs `actions: read`, `contents: write` and `pull-requests: write` ([setup](#approve-job-setup)).
- **Fork pull requests**: GitHub gives workflows a read-only token for PRs from forks unless a repository admin enables *Send write tokens to workflows from pull requests*. Without that, comments, statuses and check runs all fail for outside contributors — this is a GitHub restriction, not a TestivAI one.

## See also

- [Action source + contributing](https://github.com/testivai/testivai-oss/tree/main/action)
- [Marketplace listing](https://github.com/marketplace/actions/testivai-visual-report)
- [`docs/extension-api.md`](./extension-api.md) — the `results.json` contract the Action consumes
