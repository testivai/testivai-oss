---
title: Vibe-coded apps (Lovable, Bolt, v0)
---

# A visual safety net for your AI-built app

Apps built with Lovable, Bolt, v0, or any AI coding agent change every time
you prompt — and they almost never ship with a test suite. TestivAI gives
them a safety net **without writing a single test**: it remembers what every
page looked like, and tells you when something changes that you didn't ask
for.

## Locally: one command

With your app running (e.g. `npm run dev`):

```bash
npx testivai init            # choose local mode — creates .testivai/config.json
npx testivai witness http://localhost:3000
```

That's it. TestivAI opens a headless Chrome, finds your pages by following
same-origin links from the start page, and captures each one (screenshot +
DOM). The first run creates baselines:

```bash
npx testivai approve --all   # accept the current look as the reference
git add .testivai/baselines/ && git commit -m "visual baselines"
```

From now on, run `npx testivai witness http://localhost:3000` after any
prompt-driven change. The report at `visual-report/index.html` shows what
changed, and the DOM diff says whether the markup changed (added / removed /
attribute / text counts). The crawler records no element map, so computed
styles are not compared: when pixels differ and the DOM is identical, the
report says **styles not compared** — could be render noise or a
stylesheet-only change. A CSS-only edit looks exactly like that, so compare
the images before approving.

Want specific routes instead of crawling? List them:

```bash
npx testivai witness http://localhost:3000 --pages "/,/pricing,/dashboard"
```

or in `.testivai/config.json`:

```json
{ "pages": ["/", "/pricing", "/dashboard"] }
```

## In CI: every prompt-push gets checked

Lovable and Bolt sync your project to GitHub. Add this workflow and every
push gets a visual diff on the pull request, with approvals via a
`/testivai approve` comment:

```yaml
# .github/workflows/visual-safety-net.yml
name: Visual Safety Net

on:
  pull_request:
    branches: [main]
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  statuses: write
  checks: write

jobs:
  visual:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run build
      # start the app, then witness it (adjust the start command/port to your app)
      - run: |
          npx serve -s dist -l 3000 &
          sleep 3
          npx testivai witness http://localhost:3000
      - name: Post results
        uses: testivai/testivai-oss@v1
        if: always()
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          report-dir: visual-report

  approve-baselines:
    if: |
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request != null &&
      startsWith(github.event.comment.body, '/testivai')
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: testivai/testivai-oss/approve@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          workflow: visual-safety-net.yml
```

GitHub's Ubuntu runners have Chrome preinstalled, so no browser setup is
needed. If you use a custom runner, set `TESTIVAI_CHROME_PATH` or run
`npx playwright install chromium` and point the env var at it.

## Tips for AI-generated apps

- **Dynamic content** (clocks, feeds, random imagery) causes false diffs —
  nothing filters it for you. Hide it with
  `"ignoreSelectors": [".live-feed", "[data-clock]"]`, or exclude a fixed
  area with a geometric `"mask"` (e.g. `{ "top": 24 }`), in
  `.testivai/config.json`.
- **Tolerances**: `"maxDiffPercent"` sets how much drift you accept (a CSS
  change inside that tolerance passes too). `"noiseAutoPass"` does nothing
  for `testivai witness <url>` captures: it passes only diffs whose computed
  styles were compared and match, and the crawler does not compare styles.
- **Agents can read the results**: `visual-report/results.json` is
  machine-readable, and the [`@testivai/mcp`](https://github.com/testivai/testivai-oss/tree/main/packages/mcp) server
  lets Claude Code or Cursor see the diffs directly — so the same agent
  that changed your app can check its own work. Full setup:
  [AI agents guide](./ai-agents.md).
