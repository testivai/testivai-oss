---
sidebar_position: 1
title: CI/CD Integration
---

# CI/CD Integration

Run TestivAI visual tests automatically on every push and pull request — fully local, no account, no API key, no external services. There is nothing to configure per provider: the same commands work anywhere Node and a browser run, and everything the pipeline needs is in `results.json` and the report directory.

---

## The CI Gate

The core setup: capture, diff, and gate on visual changes. Baselines are committed to git; a changed snapshot fails the gate; the reviewer downloads the report artifact, inspects the diff, and approves locally.

```yaml title=".github/workflows/visual-tests.yml"
name: Visual Regression Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  visual-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci

      - run: npx playwright install chromium --with-deps

      - run: npm run build

      # Capture only: the reporter writes .testivai/temp/ and skips comparing.
      # In CI the gate below is what decides pass/fail, so comparing twice
      # only produces a second, non-authoritative summary.
      - run: npm test
        env:
          TESTIVAI_CAPTURE_ONLY: '1'

      - name: Visual diff gate
        run: npx testivai report --fail-on-diff

      - name: Upload visual report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: visual-report
          path: visual-report/
```

Baselines live in `.testivai/baselines/` — commit them to git (`git add .testivai/baselines/`).

:::tip Why `TESTIVAI_CAPTURE_ONLY` in CI
A reporter cannot set the process exit code — Playwright owns it, and it
reflects test results, not visual results. So `npx playwright test` can print
`Changed: 3` and still exit `0`. **`npx testivai report` is what gates the
build**, and it does its own comparison.

Setting `TESTIVAI_CAPTURE_ONLY` in CI makes that explicit: the test run
captures, the gate step compares, and there is exactly one authoritative
verdict. Leave it unset locally, where the report appearing straight after
`npx playwright test` is the point.

It's optional — without it the run simply compares twice and prints a summary
that doesn't decide anything. The reporter says so out loud when snapshots
changed.
:::

### How the gate works

Baselines are committed to the repository. When a PR changes the rendering, the Playwright test run captures new screenshots into `.testivai/temp/`, and `npx testivai report --fail-on-diff` compares them against the committed baselines. Any snapshot with a pixel diff exits non-zero, failing the CI job:

| Exit | Meaning | Gate |
|---|---|---|
| `0` | Pass | — |
| `1` | At least one snapshot changed | `--fail-on-diff` / config `failOnDiff` |
| `2` | New-only — snapshots with no baseline yet | `--fail-on-diff`; add `--allow-new` on first runs |
| `3` | Missing-only — a committed baseline received **no capture** this run | on by default (`failOnMissing`); disable with `--allow-missing` |

Precedence is changed (`1`) > missing (`3`) > new (`2`). See the [`testivai report` reference](../cli/report.md) for the full contract and `--json` output.

:::caution Exit 3 fires even without `--fail-on-diff`
The missing-baselines gate is **on by default** — a committed baseline that
nothing compared against is silent coverage loss (a deleted or renamed test
stops guarding its page). That means any run which doesn't exercise the whole
suite — a `--grep`-filtered run, a browser-matrix shard, a path-filtered job —
will exit `3` and fail CI even though nothing regressed.

**Sharded Playwright runs no longer need this** — see
[Sharded runs](#sharded-runs) above; the reporter captures without comparing and
you gate once, centrally. `--allow-missing` remains the answer for a genuinely
partial run such as a `--grep`-filtered job:

```bash
npx testivai report --fail-on-diff --allow-missing
```

Or set `"failOnMissing": false` in `.testivai/config.json` to disable it
repo-wide. Leave it on for the full-suite job — that's where it earns its keep.
:::

The reviewer downloads the `visual-report` workflow artifact from the failed run, opens `index.html` to inspect the side-by-side diffs, and decides whether the changes are intentional. To accept, re-run the tests locally, approve with `npx testivai approve --all` (or commit the updated baselines directly), and push — the next CI run passes.

> For a richer PR workflow with inline diff comments and `/testivai approve` commands, see the **[GitHub Action](/github-action)**. It can also publish each run's report to the repository's GitHub Pages and link it from the comment, so reviewers open the report in the browser instead of downloading the artifact: [Reports on GitHub Pages](/github-action#reports-on-github-pages).

---

## Baselines belong to the environment that compares them

Font rasterization differs between macOS, Windows, and Linux, so a baseline captured on your laptop will report diffs on a Linux CI runner every time. If CI is where comparisons happen, adopt CI's own captures as baselines: the [GitHub Action](/github-action) bundles every changed capture into the artifact as `visual-report/pending-baselines/`, and a `/testivai approve` PR comment commits them back to the branch.

---

## Sharded runs

Playwright shards (`--shard=i/N`) need one thing understood: **a shard must not
compare.** It only ran a slice of the suite, so from its point of view every
baseline owned by another shard received no capture. Measured on a real 8-shard
run, comparing per shard exited `3` on **every machine**, each reporting roughly
90% of the suite as missing, and produced 8 partial reports with no combined view.

The reporter handles this for you. When Playwright reports a sharded run it
switches to **capture-only**: captures land in `.testivai/temp/`, and comparison
and report generation are skipped with a note saying what to do next. Nothing to
configure.

Collect the captures, union them, and compare once:

```yaml title=".github/workflows/visual-sharded.yml"
jobs:
  shard:
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4, 5, 6, 7, 8]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npx playwright install chromium --with-deps

      # Capture-only: no comparison and no gate inside the shard.
      - run: npx playwright test --shard=${{ matrix.shard }}/8

      - uses: actions/upload-artifact@v4
        with:
          name: captures-${{ matrix.shard }}
          path: .testivai/temp/
          if-no-files-found: ignore

  visual:
    needs: shard
    steps:
      - uses: actions/checkout@v4          # baselines come from the repo
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci

      - uses: actions/download-artifact@v4
        with:
          pattern: captures-*
          path: collected/

      # merge-captures verifies every shard reported before merging, then one
      # comparison runs over the full union — the gate belongs here.
      - run: npx testivai merge-captures collected/
      - run: npx testivai report --fail-on-diff

      - uses: testivai/testivai-oss@v1
        if: always()
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

One exit code, one report, one PR comment. Missing-baseline detection is correct
**by construction** here, because it only ever runs against the complete set —
so you keep the gate rather than disabling it with `--allow-missing`.

Three consequences worth knowing:

- **Shards don't need baselines.** They never compare, so a shard can skip
  fetching them.
- **Comparison happens on one machine.** If shards land on different runner
  images, per-shard font rendering differences can produce phantom diffs against
  a single baseline set. Comparing centrally removes that variable.
- **Shards get faster** — no diffing, no report generation.

To force a per-shard report anyway, pass `captureOnly: false` to the reporter and
expect exit `3` unless you also pass `--allow-missing`.

### A lost shard must not pass quietly

If a shard crashes, is cancelled, or its runner disappears, it uploads nothing —
and a merge that simply used whatever arrived would compare **part** of the
suite. Usually the missing-baseline gate catches that, but any project running
`failOnMissing: false` would get a silent pass on reduced coverage.

So each shard writes a small `testivai-shard.json` manifest alongside its
captures, naming which shard it is and how many there are. It is written at the
*end* of the run, so a shard killed mid-flight leaves none — exactly the case
worth catching. `merge-captures` reads them and refuses to proceed if any shard
is unaccounted for:

```text
✗ expected 8 shard(s), received 6 (missing: 4, 7)
  A shard that crashed or was cancelled reports no manifest.
  Comparing now would check only part of the suite.
```

The total is taken from the manifests, so nothing extra is needed in the common
case. `--expect <n>` asserts a specific count if you'd rather state it
explicitly, and `--allow-incomplete` downgrades the failure to a warning when a
partial comparison is genuinely what you want.

A shard that ran **zero tests** still writes a manifest, so it counts as having
reported — completeness can't be inferred from file counts alone.

### Sharding in any framework

Playwright can tell its reporter `--shard=i/N`. pytest, JUnit, RSpec and a bare
Selenium script cannot — so the mechanism is **the environment, not a framework
API**, and every adapter honours the same two variables:

| Variable | Effect |
|---|---|
| `TESTIVAI_CAPTURE_ONLY=1` | Capture; skip comparison and report generation |
| `TESTIVAI_SHARD=3/8` | Declare this process as shard 3 of 8 (writes the completeness manifest) |

Being one shard of many implies capture-only, so `TESTIVAI_SHARD` alone is
usually enough. Playwright additionally auto-detects `--shard`, but that is a
convenience on top of the same contract — not a separate mechanism.

```bash
# identical shape in every language
TESTIVAI_SHARD=3/8 npx playwright test --shard=3/8
TESTIVAI_SHARD=3/8 pytest tests/ --shard-id=3 --num-shards=8   # e.g. pytest-shard
TESTIVAI_SHARD=3/8 mvn test -Dgroups=shard3
TESTIVAI_SHARD=3/8 bundle exec rspec
```

Then collect, merge and compare once, exactly as above.

:::note Parallel workers vs. sharding — different problems
**Many workers on one machine** (`pytest -n 8`, Playwright workers, JUnit
parallel) share a single `.testivai/temp/`, so there is nothing to merge. All
that matters is that exactly one process compares at the end, which the adapters
handle — the pytest plugin, for instance, reports only from the xdist controller
and never from a worker.

**Many machines** is what needs `TESTIVAI_SHARD`, the manifest, and
`merge-captures`. If your parallelism is a single machine with more workers, you
need none of this.
:::

Adapters that own an end-of-run hook (Playwright, pytest, JUnit) mark their
manifest `complete`, so a shard that started and then died is distinguishable
from one that finished. A bare Selenium script or RSpec suite has no such hook,
so its manifest records participation rather than completion — `merge-captures`
only reports incompleteness when at least one shard proves it is trackable.

### Splitting the suite in each framework

`TESTIVAI_SHARD` tells TestivAI which shard this is. **Splitting the tests is
your test runner's job** — the two are separate, and they must agree on the same
index. Verified recipes per lane:

**Playwright** — sharding is built in, and the adapter also auto-detects it, so
`TESTIVAI_SHARD` is optional here:

```bash
npx playwright test --shard=3/8
```

**Selenium (JavaScript) with Jest** — Jest 28+ has `--shard`, 1-based like
Playwright:

```bash
TESTIVAI_SHARD=3/8 npx jest --shard=3/8
```

**Python (pytest)** — use [`pytest-split`](https://pypi.org/project/pytest-split/)
(`--group` is 1-based). Run `pytest --store-durations` once and commit
`.test_durations` so the split is balanced by runtime rather than file count:

```bash
TESTIVAI_SHARD=3/8 pytest --splits 8 --group 3
```

**Java (JUnit + Maven)** — Surefire has no shard flag, so split the class list
deterministically and pass it to `-Dtest`:

```bash
TOTAL=8; INDEX=3
CLASSES=$(find src/test/java -name '*Test.java' | sort \
  | awk "NR % $TOTAL == $INDEX % $TOTAL" \
  | sed 's|.*/||; s|\.java$||' | paste -sd, -)
TESTIVAI_SHARD=$INDEX/$TOTAL mvn test -Dtest="$CLASSES"
```

**Ruby (RSpec)** — same idea; RSpec takes a file list:

```bash
TOTAL=8; INDEX=3
FILES=$(find spec -name '*_spec.rb' | sort | awk "NR % $TOTAL == $INDEX % $TOTAL")
TESTIVAI_SHARD=$INDEX/$TOTAL bundle exec rspec $FILES
```

The `awk` line assigns every file to exactly one node with no gaps or overlaps —
`sort` is what makes it deterministic across machines, so don't drop it. It
splits by file count, not runtime; for balance, order the list by duration or use
a plugin that does (pytest-split above, or Knapsack for RSpec).

:::tip Check the split before trusting it
`merge-captures` will tell you if a shard never reported, but it cannot know a
file was assigned to *no* node. Confirm your splitter covers everything:

```bash
for i in $(seq 1 8); do
  find spec -name '*_spec.rb' | sort | awk "NR % 8 == $i % 8"
done | sort -u | wc -l    # must equal the total file count
```
:::

### Sharding on other CI providers

Nothing above is GitHub-specific in shape. The flow is four steps that any
provider can express:

1. **Run tests per node**, capture-only (set `TESTIVAI_CAPTURE_ONLY=1` where the
   runner doesn't pass `--shard`, so the reporter can't auto-detect it)
2. **Publish `.testivai/temp/` per node** under a predictable name —
   `captures-1`, `captures-2`, …
3. **Collect them into one directory** on a single node
4. **`merge-captures` then `report`** — completeness check, then one comparison

| Provider | Publish / collect |
|---|---|
| GitLab CI | `artifacts:paths` on a parallel job, then `dependencies:` |
| Jenkins | `stash` per node, `unstash` in the downstream stage |
| CircleCI | `persist_to_workspace` / `attach_workspace` |
| Buildkite | `artifact_paths`, then `buildkite-agent artifact download` |

Because the manifest travels inside each node's artifact, the completeness
guarantee works the same everywhere — it doesn't depend on any provider's
job-dependency semantics.

## Advanced: Matrix Testing

Run visual tests across multiple browsers:

```yaml title=".github/workflows/visual-matrix.yml"
name: Visual Regression Matrix

on:
  pull_request:
    branches: [main]

jobs:
  visual-tests:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        browser: [chromium, firefox, webkit]
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps ${{ matrix.browser }}

      - name: Run visual tests (${{ matrix.browser }})
        run: npx playwright test --project=${{ matrix.browser }}

      - name: Visual diff gate
        run: npx testivai report --fail-on-diff --allow-missing
```

> Snapshot names should include the browser (e.g. `homepage-${browserName}`) so matrix runs don't overwrite each other's baselines.

> `--allow-missing` is required here: each shard captures only its own browser's snapshots, so the other shards' baselines would otherwise trip the exit-`3` coverage gate.

---

## Advanced: Only Run on Visual Changes

Skip visual tests when no UI code changed:

```yaml
      - name: Check for visual changes
        uses: dorny/paths-filter@v3
        id: changes
        with:
          filters: |
            visual:
              - 'src/**/*.{tsx,jsx,css,scss}'
              - 'public/**'

      - name: Run visual tests
        if: steps.changes.outputs.visual == 'true'
        run: npx playwright test
```

---

## Other CI Providers

The same recipe works anywhere Node and a browser run — no provider configuration needed:

### GitLab CI

```yaml title=".gitlab-ci.yml"
visual-tests:
  image: mcr.microsoft.com/playwright:v1.48.0-noble
  stage: test
  script:
    - npm ci
    - npx playwright test
    - npx testivai report --fail-on-diff
  artifacts:
    when: on_failure
    paths:
      - visual-report/
```

### CircleCI

```yaml title=".circleci/config.yml"
version: 2.1
jobs:
  visual-tests:
    docker:
      - image: mcr.microsoft.com/playwright:v1.48.0-noble
    steps:
      - checkout
      - run: npm ci
      - run: npx playwright test
      - run:
          name: Visual diff gate
          command: npx testivai report --fail-on-diff
      - store_artifacts:
          path: visual-report
```

### Jenkins

```groovy title="Jenkinsfile"
pipeline {
    agent any
    stages {
        stage('Visual Tests') {
            steps {
                sh 'npm ci'
                sh 'npx playwright install --with-deps chromium'
                sh 'npx playwright test'
                sh 'npx testivai report --fail-on-diff'
            }
        }
    }
    post {
        failure {
            archiveArtifacts artifacts: 'visual-report/**'
        }
    }
}
```

---

## Next Steps

- **[GitHub Action](/github-action)** — PR comments, commit statuses, `/testivai approve`, and reports on GitHub Pages
- **[`testivai report`](../cli/report.md)** — exit codes and `--json` for scripting the gate
- **[Troubleshooting](/guides/troubleshooting)** — common CI issues and solutions
