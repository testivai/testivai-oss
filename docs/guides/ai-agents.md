---
title: AI agents & code assistants
---

# Using TestivAI from an AI agent

> Looking for setup, the tool list, and a real `explain_snapshot` payload?
> See the [MCP server page](../mcp.md). This guide covers the wider workflow.


AI agents eyeball the change they just made; TestivAI remembers everything
they didn't mean to change. This guide wires the two together: your agent
(Claude Code, Cursor, Copilot Workspace, or anything MCP-capable) runs
visual tests, reads structured verdicts, sees the diff images, and
self-corrects — while baseline approval stays with a human.

Why this works well for agents, structurally:

- **No account, no API key, no network** — runs inside any agent sandbox
  with zero secrets provisioned.
- **Deterministic and cheap** — pixel + DOM comparison, not vision-model
  judgment. Same answer every run, no tokens spent on unchanged pages.
- **Machine-readable** — every run writes `visual-report/results.json`
  (semver-governed schema) with per-snapshot diff percentages, DOM change
  summaries (including `textChanges`), and noise hints.

There are three integration levels. Use the highest one your setup supports.

---

## Level 1 — Instructions file (works with every agent)

Paste into your project's `AGENTS.md` / `CLAUDE.md` / `.cursorrules`:

```markdown
## Visual verification
After changing any UI code, run the visual tests:
- project has Playwright tests wired to TestivAI → `npx playwright test`
- no test suite (e.g. AI-generated app) → `npx testivai witness http://localhost:3000`
  (start the dev server first)

Then read `visual-report/results.json` and act on each snapshot:
- `status: "changed"` with `dom.changed: true` → a real change. Compare
  `dom.summary` (added/removed elements, attribute changes, text changes)
  against what you intended. If you did not intend it, fix your code and
  re-run. If intended, report it to the human.
- `status: "changed"` with `dom.noiseHint: true` → likely render noise
  (font hinting, anti-aliasing); mention it, don't block.
- `status: "new"` → new page/snapshot; tell the human baselines need
  approving.
- Never run `testivai approve` yourself — baseline approval is a human
  decision. Suggest `npx testivai approve <name>` (or a `/testivai approve`
  PR comment) instead.
```

The agent shells out, reads JSON, and reasons over it. No extra tooling.

## Level 2 — MCP server (structured tools + the agent SEES the diffs)

`@testivai/mcp` exposes the results as tools, including the actual
baseline/current/diff **images**, so a multimodal agent can look at what
changed rather than just read numbers.

**Claude Code**

```bash
claude mcp add testivai -- npx -y @testivai/mcp
```

**Cursor / other MCP clients** — `.cursor/mcp.json` (or equivalent):

```jsonc
{
  "mcpServers": {
    "testivai": { "command": "npx", "args": ["-y", "@testivai/mcp"] }
  }
}
```

| Tool | Returns |
|---|---|
| `get_visual_results` | Per-snapshot verdicts phrased for agent decision-making, opened by groups of snapshots that share an identical signal ([what is grouped](../mcp.md#what-the-server-groups)) |
| `get_report` | The raw `results.json` payload (structured: status, diff %, DOM signal, region→selector) |
| `explain_snapshot` | Layered evidence for one snapshot: pixel regions, element attribution (shifted vs changed selectors, whole-page shift detection), DOM/style signal, and interpretation guidance — everything a model needs to explain *why* a diff happened |
| `get_diff` (alias `get_snapshot_diff`) | Baseline, current, and diff PNGs for one snapshot |
| `list_baselines` | Committed baselines under `.testivai/baselines/` |
| `approve_snapshot` | Promote one confirmed snapshot to its committed baseline |
| `approve_all` | Promote every pending snapshot (only after review) |

The server also ships a prompt, **`review-visual-changes`**, that walks the agent through a full review: summary → `explain_snapshot` per change → diff images when ambiguous → a per-snapshot recommendation (approve / investigate / ignore-as-noise). Your model does the reasoning; the server supplies the evidence — so the quality of the narrative scales with the model you already use, no hosted analysis service required.

The server reads the project from its working directory (`--root <path>` to
override) and honors `reportDir` from `.testivai/config.json`. The approve
tools exist so a human can say "approve it" mid-conversation — but an agent
must never reach for them on its own initiative. Both tool descriptions say
so, and the `review-visual-changes` prompt repeats it. See
[the approval rule](#the-approval-rule) below.

## Level 3 — Zero-test-suite apps (agent-generated code)

Apps built by agents usually have no test framework. They don't need one:

```bash
npx testivai witness http://localhost:3000
```

captures every page (crawled, or `--pages "/,/pricing"`), diffs against
baselines, and writes the same report + `results.json`. See the
[vibe-coded apps guide](./vibe-coded-apps.md) for the CI workflow.

---

## What the loop looks like (real transcript)

This is an actual session — an agent changed a button label on
[testiv.ai](https://testiv.ai), ran the tests, and read the verdict through
MCP:

```text
agent> edits index.html: "Get Started on GitHub — Free" → "… — Gratis"
agent> npx testivai witness https://testiv.ai

  ═══ TestivAI Visual Report ═══
  Total: 7  |  Passed: 6  |  Changed: 1  |  New: 0

agent> [MCP] get_visual_results

  - home: changed (0.04% pixels differ) and the DOM changed
    (0 added, 0 removed, 0 attribute changes, 2 text changes) —
    a real structural change; confirm it is intended before approving
  - faq_html: passed — no visual change
  … (5 more passed)

  Baseline approval is a human decision: suggest `/testivai approve <name>`
  on the PR (or `npx testivai approve` locally); do not approve autonomously.
```

The agent sees: *its own edit* caused exactly one page to change, the change
is textual (2 text tokens), and nothing else on the site moved. If the edit
was intended, it reports to the human for approval; if not, it just caught
its own regression before anyone else did.

## The approval rule

**Agents verify; humans approve.** Approving a baseline rewrites the
definition of "correct" — an agent that approves its own changes can launder
any mistake into the new baseline.

`approve_snapshot` and `approve_all` do exist on the MCP server, because a
human who has looked at the diff and said "yes, approve that" shouldn't have
to leave the conversation to act on it. What the design rules out is the
agent deciding on its own. That intent is enforced in the wording the model
actually reads:

- both approve tools describe themselves as "only after a reviewer has
  confirmed the changes are intended",
- the `review-visual-changes` prompt ends with an explicit *never call
  `approve_snapshot`/`approve_all` yourself unless the human has explicitly
  confirmed* instruction,
- every `get_visual_results` response ends with the same line: *do not
  approve on your own*; when the human confirms a change in the conversation,
  call `approve_snapshot`,
- the human-shaped paths stay first-class: `npx testivai approve` locally, or
  a `/testivai approve` comment on the PR (verified against repo write
  access).

In Claude Code the rule is also enforced by the client. Both approve tools
carry `anthropic/requiresUserInteraction` in `tools/list`, so Claude Code
(v2.1.214 or later) shows its permission prompt on every approve call, even in
`acceptEdits`, `auto` and `bypassPermissions` modes, with no "don't ask again"
option; allow rules don't skip it, and `dontAsk` mode denies the call. The
approval is you answering that prompt. See
[Review and approve in Claude Code](../mcp.md#review-and-approve-in-claude-code).
You can turn the forced prompt off with `--no-approval-prompt` or
`"mcpApprovalPrompt": false` ([details](../mcp.md#turning-the-approval-prompt-off)).

Other clients ignore that marker, so there these are guardrails, not a lock.
If you wire approvals into an autonomous loop or into CI, you own the
consequences — the design pushes the other way on purpose.

## Recommended config for agent workflows

```jsonc
// .testivai/config.json
{
  "stabilize": true,          // default — freezes the flake sources
  "noiseAutoPass": true,      // DOM-identical micro-diffs stop demanding attention
  "noiseMaxDiffPercent": 1,
  "ignoreSelectors": [".live-feed", "[data-clock]"]  // your dynamic regions
}
```

- `noiseAutoPass` keeps agent loops quiet: cross-run render jitter passes
  (labeled `autoPassed: "noise"` in results.json — never hidden). Text and
  structural changes always surface: the DOM diff tokenizes visible text
  precisely so wording edits can't slip through this gate.
- `ignoreSelectors` excludes dynamic elements from **both** the pixels and
  the DOM/text signal.

## Troubleshooting agent runs

| Symptom | Cause / fix |
|---|---|
| `No results found at visual-report/results.json` | Tests didn't run — run `npx playwright test` or `testivai witness <url>` first |
| Everything reports `changed` ~30%+, `noiseHint: true` | Web fonts raced the capture; re-run (the capture waits up to 10s for fonts). If persistent, ignore the affected region |
| A page reports text changes you didn't make | Dynamic content (counters, timestamps) — add it to `ignoreSelectors` |
| `No Chrome/Chromium found` (witness `<url>`) | Install Chrome, or `npx playwright install chromium` and set `TESTIVAI_CHROME_PATH` to the binary |
| `Chrome did not open its debugging endpoint` in a container | Chrome cannot use its sandbox there. Running as root this is handled automatically; otherwise set `TESTIVAI_CHROME_NO_SANDBOX=1` |
| MCP images too heavy for context | `get_diff` already downscales anything wider/taller than 1024 px before returning it (the caption reports the original dimensions). If it's still too much, use `explain_snapshot` / `get_visual_results` for text-only evidence and open the report for pixel detail |
