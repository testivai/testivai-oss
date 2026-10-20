---
sidebar_position: 5
title: testivai report
---

# `testivai report`

Compare `.testivai/temp/<name>/` captures against baselines, write the HTML report and `visual-report/results.json`.

This is the language-agnostic half of the adapter contract: any binding (Python, Java, .NET, …) captures screenshots into `.testivai/temp/<name>/` using its native APIs, then shells out to this command for diffing, tolerances, the report, and CI exit codes.

## Usage

```bash
npx testivai report [options]
```

## Options

| Flag | Description |
|---|---|
| `--fail-on-diff` | Enable the exit-code gate — exit non-zero on changes or new snapshots (overrides config `failOnDiff`) |
| `--allow-new` | Treat new snapshots as passing (exit 0). Use with `--fail-on-diff` so first runs don't fail |
| `--json` | Print the `results.json` payload to stdout instead of the pretty summary |
| `--fail-on-missing` | Force the missing-baselines gate on, overriding config `failOnMissing: false` |
| `--allow-missing` | Skip the missing-baselines gate for this run — use with filtered runs (`--grep`) where skipped baselines are expected |
| `--share` | Also write `share.html` — a single self-contained file with every image inlined as a data URI, ready to drop into Slack, an issue, or an email |
| `--open` | Open the HTML report in a browser (overrides config `autoOpen`) |

## Exit Codes

Exit codes are a public contract. Codes `1` (changed) and `2` (new-only) are enforced only when the diff gate is on (`--fail-on-diff` or config `failOnDiff`) — without it, changes and new snapshots are report-only. Code `3` (missing) has its **own** gate, `failOnMissing`, which defaults to `true`, so a bare `npx testivai report` can still exit 3. Turn it off with config `failOnMissing: false` or per-run `--allow-missing`.

| Code | Meaning |
|---|---|
| `0` | Pass — nothing changed; no new snapshots, or `--allow-new` was set |
| `1` | Changed — at least one snapshot differs from its baseline |
| `2` | New-only — new snapshots exist with no changes. Distinct from 1 so first runs and newly added tests aren't mistaken for regressions |
| `3` | Missing-only — baselines exist that received no capture this run (a deleted/renamed test silently stopped guarding its page). **On by default** (`failOnMissing` defaults to `true`); disable via config `failOnMissing: false` or per-run `--allow-missing`. Precedence: changed (1) > missing (3) > new (2) |

## `--json` Output

With `--json`, the CLI banner is suppressed and a single JSON document is written to stdout — the full `results.json` schema (summary + per-snapshot results). Agents and CI can parse stdout directly:

```bash
npx testivai report --json | jq '.summary'
```

On error, a `{ "error": "…" }` object is emitted instead.

## Sharing the report

`--share` writes `share.html` next to the report — one self-contained file with every image inlined. To push it to any storage you already use, set a **storage-agnostic upload hook** in `.testivai/config.json`:

```json
{
  "shareUploadCommand": "aws s3 cp {file} s3://my-bucket/reports/$(date +%s).html && echo https://my-bucket.s3.amazonaws.com/reports/latest.html"
}
```

`{file}` is replaced with the share file's path; the command's **last stdout line** is printed as the shared URL. Works with `aws s3 cp`, `gsutil cp`, `rclone`, `curl` — anything on your PATH. TestivAI ships no cloud SDKs; local file is the default when the hook is unset.

## Linking to a snapshot

Each snapshot's card in `index.html` has its own link target, so a link can open the report at one snapshot: `index.html#snap-checkout`. Click a snapshot's name in the report to get its link. A name made of letters, digits, `_` and `-` is kept as it is; any other name is reduced to those characters and ends in a short hash of the full name, so two names that differ only in other characters still get different targets:

- `checkout` → `#snap-checkout`
- `checkout page` → `#snap-checkout-page-bc6bc5f0`

The [GitHub Action](../github-action.md)'s PR comment links each changed or new snapshot this way once the run's report is [on GitHub Pages](../github-action.md#reports-on-github-pages). To build the same link yourself, `snapshotAnchorId(name)` from `@testivai/witness` returns the id without the `#`.

## CI Example

```bash
npx testivai report --fail-on-diff
```

Combine with `--allow-new` on the first push to avoid exit-code-2 failures while baselines are being seeded.
