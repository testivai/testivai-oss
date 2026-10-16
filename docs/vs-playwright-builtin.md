---
sidebar_position: 3
title: vs. Playwright's built-in screenshots
---

# TestivAI vs. `toHaveScreenshot()`

Playwright ships visual comparison in the box. If you already use
`expect(page).toHaveScreenshot()`, this page explains — honestly — what
TestivAI adds and when it isn't worth the dependency.

## The short answer

**If you test only with Playwright and a pixel diff answers your question, use
the built-in.** It's free, it's maintained by the Playwright team, it has no
extra dependency, and it's genuinely good. We'd rather you use it than install
something you don't need.

TestivAI earns its place when the pixel diff **stops** being the answer:

- when you need to know *why* something changed, not just that it did
- when a one-pixel layout shift fails forty snapshots and you have to eyeball
  every one
- when approving a baseline should be a reviewed decision, not a local flag
- when Playwright isn't your only framework
- when an AI agent, not a human, is reading the result

---

## What the built-in does well

Real credit where it's due — this is a well-built feature:

| | |
|---|---|
| **Stability** | Takes repeated screenshots until two consecutive ones match before comparing. This is genuinely better than a single capture, and TestivAI does not do it. |
| **Sensible defaults** | `animations: "disabled"`, `caret: "hide"`, `threshold: 0.2` (YIQ perceived colour difference) — the common flake sources are off by default. |
| **Fails where it happens** | It's an assertion, so the failure lands on the exact test, participates in Playwright's retry logic, and shows Expected / Actual / Diff in the HTML report. |
| **Per-environment baselines** | Files are stored as `{test}.spec.ts-snapshots/{name}-{browser}-{platform}.png`, so a macOS baseline never fights a Linux one. |
| **Masking** | `mask: [locator]` paints regions `#FF00FF` before comparing. `stylePath` injects CSS to hide volatile elements. |
| **Zero install** | It's already in `@playwright/test`. |

If that list covers your needs, stop here. Everything below is about problems it
doesn't try to solve.

---

## Where TestivAI is different

### 1. It tells you *why* the pixels changed

A pixel diff says *0.4% of pixels differ*. That's where the built-in's job ends
and yours begins.

TestivAI captures the DOM and an element map alongside the screenshot, so the
report answers the next question for you:

- **DOM and computed styles identical, pixels differ** → *likely* render noise
  (font hinting, anti-aliasing), labeled as such so it is quick to triage. It
  still reports `changed` unless you enable `noiseAutoPass`
- **DOM identical, computed styles differ** → a style-only change, with the
  restyled elements listed
- **DOM identical, styles not compared** (no element map on one side, e.g. a
  baseline from a capture whose element-map script was blocked) → *styles not
  compared*: could be render noise or a stylesheet-only change, so compare the
  images before approving
- **DOM differs** → a structural change, with added/removed/attribute/text counts
- Each diff region is attributed to the **CSS selector** that produced it

The verdict reads like *"Style-only change — 34 elements restyled with identical
DOM (`body`, `header`, …). Confirm it's intended before approving."*

### 2. A page shift doesn't fail everything below it

Add one line to a header and every element under it moves down a pixel. To a
pixel differ, that is dozens of independent failures.

TestivAI detects that the elements are *the same elements, moved*, reports it as
a single page shift, and — with `shiftTolerance` set — passes them. The moved
content is still shown in the report, marked as shifted rather than changed.

### 3. Approval is a reviewed decision

The built-in updates baselines with `--update-snapshots`, which rewrites
everything the run touched. It's fast, and it's all-or-nothing: an unintended
regression captured in the same run gets blessed alongside the intended change.

TestivAI's flow keeps a human in the loop:

- CI posts the diff on the pull request and uploads the report
- a reviewer comments `/testivai approve <name>` (or `--all`)
- the action **verifies the commenter has write access**, then commits the new
  baselines back to the branch

The approval is attributable, reviewable, and lands in git history like any
other change.

### 4. It notices when a baseline stops being checked

Delete or rename a test and its baseline silently stops guarding that page. No
pixel differ can detect this, because nothing was compared.

TestivAI tracks baselines that received no capture, lists them in the report,
and exits `3` by default. That default is deliberate — silent coverage loss is
the failure mode nobody catches on their own.

### 5. One baseline set across frameworks

If your suite is Playwright plus Selenium, or a Python or Java lane, the
built-in covers only the Playwright part. TestivAI's adapters all read and write
the same `.testivai/baselines/` directory and produce one report.

### 6. Machine-readable, for agents

Every run writes `visual-report/results.json` under a semver-governed schema,
and [`@testivai/mcp`](./guides/ai-agents.md) exposes it to any MCP client —
including `explain_snapshot`, which hands a model the layered evidence for one
snapshot so it can explain the change in your own words. The model is yours;
we ship the evidence, not the inference.

---

## Side by side

| | `toHaveScreenshot()` | TestivAI |
|---|---|---|
| Pixel diff | Yes | Yes |
| Retry until stable | Yes | — (freezes animations, hides caret, waits for fonts) |
| Fails the individual test | Yes | — (run-level report + exit code) |
| Per-browser / per-OS baselines | Yes automatic | Yes via project suffix and `{platform}` token |
| Masking | Yes | Yes (hatched and listed in the report) |
| DOM / style diff — *why* it changed | — | Yes |
| Region → selector attribution | — | Yes |
| Page-shift detection | — | Yes |
| Noise vs. real change verdict | — | Yes (DOM diff + computed-style check) |
| Review-then-approve in a PR | — | Yes (write access verified) |
| Missing-baseline detection | — | Yes (exit 3 by default) |
| Shared baselines across frameworks | — | Yes |
| `results.json` + MCP for agents | — | Yes |
| Extra dependency | none | one dev dependency |

---

## Choosing

**Use the built-in if** Playwright is your only framework, you're comfortable
reviewing diffs by eye, and `--update-snapshots` on your own machine is an
acceptable way to approve changes. That describes a lot of good test suites.

**Reach for TestivAI when** you're spending real time asking *why did this
change*, when small layout shifts make diffs noisy enough to ignore, when
baseline approval needs to survive review by someone other than the author, or
when an agent is doing the first pass.

**They can coexist.** Nothing stops you keeping `toHaveScreenshot()` on the
handful of components where a strict pixel lock is exactly right, and running
TestivAI across the pages where you need the explanation. They use separate
baseline directories and won't collide.

---

→ [Getting started](./intro.md) · [How it works](./how-it-works.md) ·
[Masks, regions & tolerances](./comparison.md)
