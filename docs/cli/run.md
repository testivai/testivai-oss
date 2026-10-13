---
sidebar_position: 3
title: testivai run
---

# testivai run

Wraps your test command, connects to Chrome via remote debugging, and captures visual snapshots.

## Usage

```bash
testivai run "<your-test-command>" [options]
```

## Examples

```bash
# Cypress
testivai run "cypress run --browser chrome"

# pytest
testivai run "pytest tests/ -v"

# Jest + Selenium
testivai run "npx jest tests/"

# Maven / JUnit
testivai run "mvn test"

# Robot Framework
testivai run "robot tests/"

# RSpec
testivai run "bundle exec rspec"
```

## How It Works

1. Starts your test command as a child process, with `TESTIVAI_MODE=local` and the debugging port exported into its environment
2. Waits for Chrome to open `--remote-debugging-port=9222` (retries for up to 60s)
3. Connects via browser WebSocket
4. Injects `window.testivaiWitness` globally
5. Each `witness()` call captures a screenshot over CDP (no DOM snapshot and no element map) and keeps it in memory
6. When the test command exits, compares the captures already on disk in `.testivai/temp/` against `.testivai/baselines/` and writes the HTML report + `results.json` to `visual-report/` — everything stays on disk

Known gap: the sidecar does not yet write its own screenshots to `.testivai/temp/`, so the report covers only captures already on disk. See [the sidecar caveats](../sidecar-testivai-run.md).

The command exits with your test command's exit code, or `1` when
`failOnDiff` is set in `.testivai/config.json` and snapshots changed.

## Options

| Flag | Description |
|---|---|
| `-p, --port <number>` | Chrome remote debugging port (default `9222`) |
| `--debug` | Enable debug logging for snapshots |
