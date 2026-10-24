# Changelog — testivai-oss repo

Human-readable history of repo-level changes (CI, release tooling, docs, governance). Per-package release notes live in each package's own `CHANGELOG.md` and on the npm package page.

The repo follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions; package versions follow [SemVer](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed
- `docs/guides/docker.md` and `docs/guides/headless.md` — replaced the "Coming Soon" placeholders, which were published on testiv.ai/docs, with real guides: one Docker image for capture and approval, the official Playwright image, Chromium for `testivai witness <url>`, the root/sandbox variables, and keeping headless capture conditions identical.
- `docs/maintenance.md` — dropped the version and release counts, which had gone stale; the releases page is the live record.
- This file: `docs/oss-vs-cloud.md` and `docs/frameworks/cloud-only-frameworks.md`, listed under Added below, were removed with the cloud lane in #82. The Action is `testivai/testivai-oss@v1` since the repository moved to the testivai org (#133); entries below that say `mcbuddy/testivai-oss@v1` describe it before the move.

### Added
- `docs/oss-vs-cloud.md` — capability matrix; explicit boundary between the OSS lane (pixel + DOM) and the cloud lane (CSS + layout + AI counselor + dashboard + history).
- `docs/github-action.md` — full reference for `mcbuddy/testivai-oss@v1`, including PR comment shape and DOM noise hint output.
- `docs/extension-api.md` — stable contract for community adapters: on-disk `.testivai/` layout + `results.json` schema. Versioned, governed by SemVer.
- `docs/sidecar-testivai-run.md` — explicit "experimental" labeling for the framework-agnostic CDP sidecar; documents launch-coordination + race-condition pitfalls and recommends per-framework adapters instead.
- `docs/frameworks/cloud-only-frameworks.md` — single redirect for Cypress, Puppeteer, Selenium, Robot, RSpec, Cucumber. Points at iter-2 plans, the experimental sidecar, and the extension-API path for community adapters.
- `CHANGELOG.md` (this file) — repo-level history.

### Changed
- `docs/philosophy.md` gains a "Free and open source" section (MIT, free to use including commercially, no account, no caps); `docs/maintenance.md`, `ROADMAP.md`, `CLAUDE.md`, `AGENTS.md` and `REVIEW.md` drop the "no paid tier / no pricing page" forever-statements. Nothing changes in the software or the license. A guard test (`packages/witness/src/__tests__/promise-wording.test.ts`) now enforces the wording.
- `docs/README.md` — rewritten as a navigable index that lists what actually ships (Playwright + WDIO + GitHub Action), not the aspirational set.
- `docs/intro.md` — Path A is now "dedicated adapters (Playwright + WebdriverIO)"; Path B is labeled experimental sidecar with cross-link to the new caveats doc.

### Removed
- `docs/concepts/reveal-engine.md` — described the retired hosted service's analysis engine; removed from OSS docs.
- `docs/concepts/baselines.md`, `docs/concepts/performance-metrics.md` — placeholder stubs ("Coming Soon"); content folded into `intro.md` and the framework adapter pages.
- `docs/concepts/browser-integration.md` — described the sidecar architecture; superseded by `docs/sidecar-testivai-run.md`.
- `docs/concepts/test-statuses.md` — described cloud statuses (PENDING, PROCESSING, AI_PROCESSING_ERROR); OSS uses the simpler `passed | changed | new` schema documented in `docs/extension-api.md`.
- `docs/frameworks/overview.md` and 11 cloud-only framework pages (Cypress, Puppeteer, Selenium ×6, Robot, RSpec, Cucumber) — replaced by `docs/frameworks/cloud-only-frameworks.md` plus the OSS adapter pages for Playwright and WebdriverIO.

## 2026-05-08

### Added
- New package: **`@testivai/witness-webdriverio@0.1.0`** — local-mode WDIO adapter (W5 of OSS plan v3). Service + `testivai.witness(browser, name)` capture. ~7 KB packed. Uses `browser.takeScreenshot()` + `browser.execute()`; no CDP, no port poll. Cloud mode pending.
- GitHub Action shippable from this repo as `mcbuddy/testivai-oss@v1` (W4). `action.yml` at repo root for Marketplace eligibility; bundled `dist/` committed; CI guard verifies `dist/` matches src; release-action workflow rolls major-tag on every clean semver tag.
- Action PR comment now surfaces the DOM noise hint (W3 follow-through).
- `@testivai/witness` now ships pixel + DOM comparison (W3). Self-rolled tokenizer + multiset comparator, ~5 KB gzipped on the wire. Surfaces "DOM unchanged → likely render noise" hint in the local HTML report and in PR comments via the GitHub Action.

### Changed
- CI matrix expanded from `{ubuntu, Node 20}` to `{ubuntu, macos} × {Node 20, 22}` (W2). Windows deferred until OSS surface stabilizes.
- npm publish now emits provenance attestations (W1).
- `pnpm/action-setup` bumped from v2 to v4; pnpm version sourced from `packageManager` field in `package.json`.

### Added
- Repository hygiene (W1): `SECURITY.md`, `.github/PULL_REQUEST_TEMPLATE.md` (updated), `.github/CODEOWNERS` (set to `@mcbuddy`), `.github/dependabot.yml` (npm + github-actions, weekly, grouped), `.github/workflows/codeql.yml` (security-extended).

### Fixed
- `action.yml` moved to repo root (was under `action/`) so GitHub Marketplace auto-listing works. Action consumers now `uses: mcbuddy/testivai-oss@v1` (no path).

## Earlier history

For initial extraction history (Phase 1–10 of the SDK split out of the private TestivAI monorepo), see the initial commits on `main`.
