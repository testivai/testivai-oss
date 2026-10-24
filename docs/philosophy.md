---
sidebar_position: 2
title: Philosophy
---

# Philosophy — local-first, bring your own model

TestivAI is built on two convictions about visual regression testing.

## 1. Detection belongs on your machine

Capture, diff, report, and approve are local operations. Your screenshots and
DOM snapshots never need to leave your repo:

- **Baselines live in git** — versioned, reviewable, no external storage.
- **The report is a file** — `visual-report/index.html` is self-contained;
  share it as a CI artifact, open it anywhere.
- **The contract is public** — `results.json` is a semver-governed schema
  (status, diff %, region→selector attribution, DOM/style signals) that any
  tool can consume.
- **No account.** There is nothing to sign up for, and the packages never ask.

Local-first isn't a limitation — it's what makes TestivAI usable inside CI
sandboxes, air-gapped environments, and AI-agent loops without provisioning
a single secret.

## 2. The AI layer is *your* AI

Most visual testing tools bundle a hosted AI service to explain diffs.
TestivAI deliberately doesn't. The layered analysis — pixel regions, element
attribution ("`div.card:nth-of-type(2)` shifted +24px"), whole-page shift
detection, style-only-change detection, the DOM noise hint — is computed
locally and handed to **whatever model you already use** through the
[`@testivai/mcp`](https://github.com/testivai/testivai-oss/tree/main/packages/mcp) server:

- `explain_snapshot` gives your agent the layered evidence bundle.
- The `review-visual-changes` prompt turns it into a review narrative.
- Claude Code, Cursor, Copilot, or any MCP client — the reasoning quality
  scales with *your* model, and nothing is uploaded to us.

The server ships evidence; the client ships intelligence. That split keeps
TestivAI free, private, and permanently un-lock-in-able.

## What this means practically

| You want | You get |
|---|---|
| Visual regression in CI | The [CI gate recipe](./guides/ci-cd.md) — commit baselines, gate on `testivai report --fail-on-diff` |
| PR-based approvals | The [GitHub Action](./github-action.md) — diff comment + `/testivai approve` |
| AI explanations of diffs | The [MCP server](./guides/ai-agents.md) + your own agent |
| Fewer false positives | [Stable baselines guide](./guides/stable-baselines.md) — stabilized captures, ignore modes, noise auto-pass |

Everything above is MIT-licensed and works offline — and it stays that way:
see [What stays free](#what-stays-free).

## What stays free

The MIT-licensed packages are complete on their own: capture, comparison,
every verdict, the HTML report, the GitHub Actions, the MCP server and the
`results.json` contract. They need no account, send nothing anywhere, and keep
working offline on the version you pinned.

That is not a launch-week promise. Whatever this project becomes:

- **Nothing moves out of the free packages.** A feature that is free today
  stays free, and the license of anything already released never changes.
- **Nothing in your CI will ever depend on an account, a key or a license.**
  Capture, compare, report and approve run the same whether or not anyone
  pays for anything.
- **No telemetry.** The software never phones home.

Today there is no paid product and no hosted service. If one ever exists it
will be built *around* the packages — support, maintenance commitments,
tooling on top — never *out of* them, and it will be announced on this page
before it exists, not discovered in a changelog.
