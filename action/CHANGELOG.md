# Changelog

All notable changes to testivai-action will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
