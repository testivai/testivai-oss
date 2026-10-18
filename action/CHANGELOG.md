# Changelog

All notable changes to testivai-action will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- The PR comment reads capture provenance from `results.json` (`@testivai/witness` schema 2.5.0): when the baseline and the current capture both recorded their environment and the rendering environment changed (a browser build, OS or distro, device scale, capture method), a diff with an identical DOM and matching styles reads **Rendering drift** with the change named ("chromium 130.0.6723.58 → 141.0.7390.37"), never "likely render noise"; a size change from another capture method reads **Capture method changed**; a snapshot that `environmentPolicy: "strict"` made changed says so; any other reading keeps its line and mentions the environment change as context. When two or more snapshots share one change, the comment says it once at the top with an honest count of how many are drift. The review action's triage rubric (bundled in `dist/review.cjs`) gets a row for rendering drift: a glitch of the environment, or an intended change when the change under test upgraded the environment; re-baseline either way

### Fixed

- A taller or shorter capture no longer reads as "content was added below the baseline's height" in the PR comment: the padded band at the bottom is the page's new height, not where the change is. The **Size changed** line now uses the same reading as the report and the MCP verdicts (`explainHeightChange` from `@testivai/witness`): a page shift places the change ("everything below y=203 moved down 73 px, so look above that line"; the separate **Layout shift** line is then not repeated), a DOM change says what changed but not where, and an identical DOM is the same content laid out taller or shorter (restyled, or often fonts or rendering that differ between machines), never content added or removed

## [1.3.0] - 2026-10-17

### Changed
- The PR comment reads `sizeMismatch` from `results.json` (`@testivai/witness` schema 2.4.0): when the current capture's dimensions differ from the baseline's, the snapshot row shows both sizes (`baseline 1280×2348 → current 1280×2538 (+190 px)`) and the body opens with **Size changed**: a taller or shorter page is content added or removed, read with the DOM summary; a width change is the viewport or device scale, not the page. The identical-DOM readings (likely render noise, styles not compared) are withheld for such a snapshot, because its diff is on a padded canvas in which every padded pixel counts as changed (#197)

## [1.2.0] - 2026-10-16

### Changed
- `testivai/testivai-oss/review@v1` triages missing baselines too: committed baselines that got no capture this run (`missingBaselines` in `results.json`), because their test was removed, renamed or skipped, or failed before it captured. A push whose only finding is a missing baseline now starts a run instead of skipping with "nothing to triage". The prompt lists missing baselines apart from the changed and new snapshots (one cap of 30 names across both) and says where each one's committed baseline is (`baselinesDir` in `.testivai/config.json`, `{platform}` included, else `.testivai/baselines`), so Claude can read its `screenshot.png` even with an older `@testivai/mcp`. The shared rubric judges one by the change under test: an intended removal or rename, a bug (an unintended one, or a change that broke the test before its capture), otherwise a possible bug with a pointer to the test run's log; never a glitch. The comment marks those rows `(missing)`, counts them in the tally, and says that approving does nothing for them: an intended removal deletes the baseline directory. With `failOnMissing: false` in `.testivai/config.json` (missing baselines are expected, as in a `--grep` run or one browser lane of a matrix) they are left out, so they never start a run on their own (#193)

## [1.1.1] - 2026-10-16

### Changed
- `testivai/testivai-oss@v1` runs on Node 24 (`runs.using: node24`, dist built for node24), and `approve@v1` and `review@v1` run their scripts on `actions/github-script@v9` (`approve@v1` checks out with `actions/checkout@v7`) instead of releases that target Node 20, which GitHub's runners deprecate. Inputs and outputs are unchanged. Self-hosted runners need Actions Runner v2.327.1 or later, the minimum `actions/github-script` v8+ and `actions/checkout` v5+ require; GitHub-hosted runners already have it (#182)

## [1.1.0] - 2026-10-16

### Added
- `testivai/testivai-oss/review@v1` (`review/action.yml`): on a pull request with a changed or new snapshot, Claude (`anthropics/claude-code-action`) triages each one as a glitch, an intended change, a bug or a possible bug, using the TestivAI MCP server, the images and the pull request's diff, and posts one comment updated on each push. It uses the MCP server's `triage-visual-diff` rubric, bundled as `dist/review.cjs`. Advisory: it never changes the visual check or a baseline, and Claude gets read-only tools. It skips without using tokens when `enabled: false`, when nothing changed, on non-PR events, without a Claude credential (`anthropic-api-key` or `claude-code-oauth-token`), or for a bot not in `allowed-bots`; `model` and `max-turns` bound the cost. Claude reads only inside the workspace (not `.git`, `/proc` or `/sys`) and gets the job's own `github.token`; its answer is posted with secrets redacted and HTML, mentions, links and images defanged, within GitHub's comment size limit. A run superseded by a newer push never writes the comment, and a comment that cannot be written is a warning, not a failed job

### Changed
- The PR comment calls an identical-DOM diff with matching computed styles "likely render noise" only when the diff is small and scattered. When every diff region fits in a box covering at most a third of the page, it says **DOM and styles unchanged, but the diff is concentrated in one area**, names the regions and their box, and says it is a bad capture or a change the style check does not cover (size, overflow, transform, images…); a spread-out diff over 1% of pixels says **the diff is large**. Both ask for the images to be compared before approving. The rule is `diffShape` from `@testivai/witness`, read from `results.json` fields older witness versions already write

## [1.0.10] - 2026-07-14

### Added
- `status-context` input to customize the commit status context (default `TestivAI / visual`), so repos with multiple visual lanes (e.g. Playwright + pytest) can post separate statuses instead of overwriting each other. A non-default context also namespaces the PR comment upsert marker, giving each lane its own comment; the default context keeps the legacy marker so existing PR comments continue to update in place

## [1.0.0] - 2025-04-12

### Added
- Initial release
- GitHub Action for posting TestivAI visual reports
- Support for local mode results.json
- Markdown comment generation with emoji summary
- Configurable report directory
- Configurable artifact retention
