---
sidebar_position: 4
title: testivai witness
---

# `testivai witness`

Capture visual snapshots. Two modes, selected by the argument:

## Standalone mode — `testivai witness <url>`

Captures a **running app with no test suite**. Built for AI-generated and
vibe-coded apps.

```bash
npx testivai witness http://localhost:3000
```

What happens:

1. Launches a headless Chrome (or reuses a debuggable one — see `--port`).
2. Resolves pages: `--pages` / config `pages` when set, otherwise crawls
   same-origin links from the start page (capped by `--max-pages`, default 10).
3. Per page: applies capture stabilization and `ignoreSelectors`, takes a
   full-page screenshot + DOM snapshot, writes to `.testivai/temp/<name>/`.
4. Diffs against `.testivai/baselines/` with your configured tolerances and
   writes the HTML report + `results.json`.

Snapshot names come from paths: `/` → `home`, `/pricing/plans` → `pricing-plans`.

| Flag | Meaning |
|---|---|
| `--pages "/,/pricing"` | Capture exactly these paths (disables crawling). Also settable as `pages` in `.testivai/config.json` |
| `--max-pages <n>` | Crawl cap (default 10; config: `maxPages`) |
| `--viewport 1280x800` | Capture viewport (default 1280x800; config: `viewport`) |
| `-p, --port <n>` | Reuse an already-running Chrome with `--remote-debugging-port` instead of launching one |

Chrome resolution: `TESTIVAI_CHROME_PATH` env var → standard install
locations → PATH. A Playwright-downloaded Chromium works:
`npx playwright install chromium`, then point the env var at the binary.

In containers, Chrome is launched with `--no-sandbox` automatically when the
process runs as root (which is the default in most Docker images).
`TESTIVAI_CHROME_NO_SANDBOX=1` forces it on for non-root containers whose
seccomp profile still blocks the sandbox; `=0` forces it off.

TestivAI waits up to 30s for Chrome to open its debugging endpoint;
`TESTIVAI_CHROME_STARTUP_TIMEOUT_MS` changes that (for slow CI runners). If
Chrome exits instead, the run fails straight away with its exit code and the
end of its stderr, so a crash and a slow start are told apart.

First run creates baselines — approve and commit them:

```bash
npx testivai approve --all
git add .testivai/baselines/
```

See the [vibe-coded apps guide](../guides/vibe-coded-apps.md) for the
GitHub Actions workflow.

## Sidecar mode — `testivai witness <name>`

Captures a single named snapshot from an **already-running debuggable
Chrome** (used inside `testivai run` wrappers for frameworks without a
first-class adapter):

```bash
npx testivai witness checkout-page --port 9222
```

| Flag | Meaning |
|---|---|
| `-p, --port <n>` | Chrome remote debugging port |
| `-o, --output <path>` | Output directory (default `.testivai/witnesses`) |
| `-f, --format json\|png` | Output format |
