# Roadmap

What's missing, in the order we intend to fix it. Informed by a code audit
(2026-07) and the reasons teams abandon visual testing: false-positive
fatigue, non-deterministic captures, and baseline maintenance burden.

Sizes: **S** < a day · **M** days · **L** week+. Issues welcome for any item;
items marked *(community)* are good community contributions.

## 1. Correctness first — things that behave like bugs

### 1.1 Baseline keying by project / browser — SHIPPED
Multi-project Playwright configs now key snapshots as `<name>__<project>`
(single-project configs untouched — no migration needed); WebdriverIO gets a
per-call `variant` option for multi-capability runs. The variant lives in
the snapshot name, so the on-disk layout, results.json, report, and both
approve flows work unchanged. Unblocks cross-browser (3.3) and the viewport
matrix (2.3). Still open:
- standalone `witness <url>` viewport-matrix keying (`__WxH`) — lands with 2.3

### 1.2 Capture stabilization defaults — SHIPPED
Both adapters now freeze CSS animations/transitions, hide the caret, force
instant scrolling, and wait (bounded 3s) for web fonts before every capture —
on by default, off via `stabilize: false` (config.json, project config, or
per call). Still open from the original plan:
- optional `waitForStable` (two identical consecutive frames) for stubborn pages — **S** *(community)*

### 1.3 Pass criteria that match human intuition — SHIPPED (project-level)
`.testivai/config.json` now supports `maxDiffPercent`, `maxDiffPixels`, and
opt-in `noiseAutoPass` + `noiseMaxDiffPercent`. Auto-passed snapshots keep
their diff image and are labeled in the report and `results.json`
(`autoPassed`). Byte-different but visually identical captures now pass
instead of reading `changed 0.01%`. Still open:
- per-snapshot tolerance override via `witness()` options (needs metadata
  plumbing from capture to compare) — **M**

## 2. Workflow completeness

### 2.0 Zero-test-suite mode — SHIPPED
`testivai witness <url>` captures a running app with no test framework:
same-origin crawl or explicit `--pages`, launches its own headless Chrome,
full stabilization + ignoreSelectors parity, standard pipeline downstream
(baselines, tolerances, report, PR approvals). Built for AI-generated and
vibe-coded apps (Lovable, Bolt, v0) that ship without tests. Still open:
- viewport matrix per page (blocked on baseline keying, 1.1)
- `waitForStable` frame-compare for JS-animated pages *(community)*

### 2.1 Masking — SHIPPED (witness 1.4.0)
Full masking DSL: config + per-call `mask` accepting CSS selectors
(geometry captured at capture time) or geometric regions (px, 0–1 ratios,
"NN%", edge shorthands like `{ top: 24 }`). Masked areas are excluded from
the diff AND hatched in the diff image with a full audit trail — never
silent. `ignoreSelectors` (capture-time hiding) stays for content that
should never be captured; `docs/comparison.md` explains which to use when.

### 2.2 Element-level snapshots — **M**
`witness(page.locator('.card'), ...)` for component-scoped baselines.
Component-level capture is how design-system folks think; today we only do
full-page.

### 2.3 Multi-viewport matrix — **S** (after 1.1)
`viewports: [[1280,800],[375,812]]` in config → one `witness()` call captures
each, baselines keyed per viewport.

This is the *in-project* matrix and it is genuinely unbuilt. It is not the same
thing as mobile coverage, which already works: one Playwright **project** per
device profile keys baselines as `<name>__<project>` (1.1), and the DOM and
computed-style attribution survives device emulation intact. See
[the mobile web guide](./docs/guides/mobile-web.md). 2.3 would remove the
per-device project boilerplate, not enable mobile.

### 2.4 Report: diff view modes, filtering, keyboard nav — **M** *(community)*
The report has side-by-side + zoom. Reviewers of 50+ snapshots need: overlay
blink/swipe/onion-skin modes, status + name filtering, `j/k` keyboard
navigation, "copy approve command" per snapshot (exists) and per selection.

### 2.5 Sharded CI merge — SHIPPED (witness 1.12.0)
Shipped by not merging reports at all: a shard that only ran a slice of the
suite must not compare, so the reporter switches to capture-only on a sharded
run and `testivai merge-captures <dirs...>` unions the shards' captures for a
single comparison — one report, one results.json, one exit code.
`merge-captures` also refuses to proceed when a shard never reported, naming
the missing indices (`--expect <n>`, `--allow-incomplete`). Since 1.13.0 the
contract is cross-language: `TESTIVAI_SHARD=i/N` and `TESTIVAI_CAPTURE_ONLY=1`
are honoured by the Playwright, Selenium, Python, Java and Ruby adapters, with
Playwright's `--shard` auto-detection as a convenience on top. The workflow is
documented in [the CI/CD guide](./docs/guides/ci-cd.md#sharded-runs). Still open:
- `docs/github-action.md` doesn't mention sharding; the recipe lives only in
  the CI/CD guide

### 2.6 `testivai status` — **S** *(community)*
Print the latest results summary in the terminal (per-snapshot verdicts,
same wording as the MCP tool) without opening the HTML report.

### 2.7 Retry & flake awareness — **M**
When Playwright retries a test, only the final attempt should produce a
capture (today every attempt writes to temp). Track snapshots whose status
flip-flops across recent runs and badge them "flaky" in the report.

## 3. Detection depth

### 3.1 Computed-style fingerprint — SHIPPED (witness 1.6.0)
The documented false negative, closed: captures carry a per-element
computed-style digest (fixed property list), and the noise hint fires only
when DOM **and** style digests both match. A stylesheet-only change now
reads as an attributed "Styles changed" signal (`dom.styleCheck`,
`dom.styleChanges` in results.json) that `noiseAutoPass` can never
auto-pass. The benchmark failure case is a permanent regression test.

### 3.2 Diff region → element attribution — SHIPPED (witness 1.5.0)
Changed-pixel regions are clustered and intersected with the capture-time
element map: the report says *which element* changed —
"`div.card:nth-of-type(2)` shifted +8px vertically — content unchanged" —
with exact (dx, dy) derived from layout, and a whole-page `pageShift`
signal for the injected-banner case. No local-first tool does this; it's
also the single most useful output for an AI agent deciding whether its
change was intended (see `docs/guides/ai-agents.md`).

### 3.3 Cross-browser validation — SHIPPED
Nothing in the capture path is Chromium-specific (native Playwright APIs
throughout), and baseline keying (1.1) makes multi-browser configs safe:
each Playwright project gets its own baselines (`<name>__chromium`,
`__firefox`, `__webkit`). Verified stable across all three engines in the
demo app (18 snapshots, repeated runs, zero flakes). See the cross-browser
section in `docs/frameworks/playwright.md`. The standalone `testivai
witness <url>` crawler and the `testivai run` sidecar remain
Chromium-only (CDP).

### 3.4 Anti-aliasing tuning — **S** *(community)*
Expose pixelmatch's `includeAA` and per-channel threshold in config for
teams that want stricter or looser rasterization tolerance.

## 4. Ecosystem

- **Python adapter** — SHIPPED and **live on PyPI** (`pip install testivai`):
  playwright-python + Selenium capture, pytest plugin, powered by the
  `testivai report` CLI contract
- **Java adapter** — source complete in `java/` (JUnit 5 extension), experimental
  until Maven Central publish + CI compile *(community)*
- **Selenium adapters** — SHIPPED natively in all three SDK languages:
  `@testivai/witness-selenium` (npm), `testivai[selenium]` (Python),
  `SeleniumWitness` (Java). Full-page via CDP on Chromium; Firefox native
  full-page in Python/Java. C# stays on the sidecar / extension API.
- **Cypress adapter** — **M** *(community)* planned; adapter interface doc coming so the
  community can own it (same for Puppeteer)
- **Storybook mode** — decision pending demand (component-story capture loop)
- **MCP server** — shipped (`@testivai/mcp`), including image downscaling for
  model-context friendliness; next: an opt-in `run_visual_tests` tool
- **Ruby adapter** — SHIPPED (`testivai` on RubyGems): native Capybara /
  RSpec / Cucumber capture, no sidecar and no Chrome debug port
- **`testivai run` sidecar** — remains experimental, now only needed for
  bindings without a native adapter (C#) and for Cypress / Puppeteer /
  Robot Framework; graduates only if demand shows up in issues

---

**What we deliberately don't build:** a hosted service, dashboards, or
anything that needs an account — TestivAI is local-first by
[philosophy](./docs/philosophy.md). Collaboration happens through git
(committed baselines), the PR workflow, and shareable single-file reports.

Have a need that isn't here? [Open an issue](https://github.com/testivai/testivai-oss/issues) —
adoption stories with concrete pain move items up this list.
