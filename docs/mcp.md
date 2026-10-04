---
sidebar_position: 6
title: MCP server
---

# MCP server — visual results for AI agents

`@testivai/mcp` exposes a run's results to any [MCP](https://modelcontextprotocol.io)
client: structured verdicts, the actual diff images, and `explain_snapshot`,
which hands a model the layered evidence for one snapshot so it can explain *why*
something changed.

**The model is yours.** TestivAI ships the evidence, not the inference — there's
no hosted AI, no API key, and no per-screenshot pricing. Whatever model you
already pay for does the reasoning, and the quality scales with it.

## Setup

**Claude Code**

```bash
claude mcp add testivai -- npx -y @testivai/mcp
```

Add `--scope project` to write it to `.mcp.json` at the project root instead,
so everyone who opens the repository in Claude Code gets the same server:
`claude mcp add --scope project testivai -- npx -y @testivai/mcp`.

**Any other MCP client** — Cursor, Copilot, Zed, or your own — point it at the
same command:

```jsonc
{
  "mcpServers": {
    "testivai": { "command": "npx", "args": ["-y", "@testivai/mcp"] }
  }
}
```

The server reads the project from its working directory (`--root <path>` to
override) and honours `reportDir` from `.testivai/config.json`. It runs locally
and makes no network calls.

When there is no report yet it says *why*, rather than assuming the tests never
ran — on a sharded CI node the tests did run, and the comparison happens
elsewhere:

```text
No results found at visual-report/results.json because this is capture-only
shard 3/8. 1 capture(s) are in .testivai/temp/, but no comparison ran here — a
shard sees only its slice of the suite. The report is produced by the job that
merges every shard.
```

## Review and approve in Claude Code

With the server added, a visual review happens in the conversation:

1. Run your visual tests (`npx playwright test`), or ask Claude to.
2. Type `/testivai:review-visual-changes` (`/mcp__testivai__review-visual-changes`
   also works), or just ask *"what changed visually?"*. Claude reads the
   verdicts, calls `explain_snapshot` for each change, looks at the diff images
   with `get_diff` when the evidence is ambiguous, and recommends approve,
   investigate, or ignore-as-noise for each snapshot.
3. To accept a change, say so: *"approve home"*. Claude calls
   `approve_snapshot`, and Claude Code shows its permission prompt for that
   call. Answer **Yes** to approve it, or **No** to keep the current baseline.
4. Commit `.testivai/baselines/`.

The prompt in step 3 appears on **every** approve call. Both approve tools are
marked with `anthropic/requiresUserInteraction` in `tools/list`, so Claude Code
(v2.1.214 or later) asks every time, even in `acceptEdits`, `auto` and
`bypassPermissions` modes, offers no "don't ask again", and does not let allow
rules skip it; in `dontAsk` mode it denies the call. An approval therefore
always comes from you answering the prompt, never from the model alone. Other
MCP clients ignore the marker and apply their own tool-approval settings.

### Turning the approval prompt off

If you'd rather not confirm every approval, turn the forced prompt off. The
approve tools then follow your normal Claude Code permission settings: you can
allow them with a permission rule (`mcp__testivai__approve_snapshot`,
`mcp__testivai__approve_all`), answer "don't ask again", or run in an
auto-approving mode. Two ways, and the flag wins when both are set:

- **Per user:** pass `--no-approval-prompt` to the server, e.g.
  `claude mcp add testivai -- npx -y @testivai/mcp --no-approval-prompt`.
  `--approval-prompt` turns it back on.
- **Per project:** set `"mcpApprovalPrompt": false` in `.testivai/config.json`.
  It applies to everyone who uses the repository, so commit it deliberately.

The server reads both when it starts; restart it (or the Claude Code session)
after changing them. The tool descriptions still tell the model to approve
only when you confirm, but with the prompt off nothing in the client enforces
that.

**Seeing the images.** `get_diff` returns the baseline, current and diff PNGs
to Claude, which looks at them inline; Claude Code also saves the original
bytes in the session's `tool-results` directory under `~/.claude/projects/`.
For yourself, `get_visual_results` ends with the absolute paths to open: the
HTML report (side-by-side baseline, current and diff), each changed snapshot's
diff image, and each new snapshot's capture.

## Tools

| Tool | Returns |
|---|---|
| `get_visual_results` | Every snapshot with a one-line verdict phrased for decisions, opened by [groups of snapshots that share an identical signal](#what-the-server-groups) when there are any, then the paths to open: the HTML report, each changed snapshot's diff image, each new snapshot's capture |
| `explain_snapshot` | Layered evidence for one snapshot — pixel regions, element attribution, DOM/style signal, interpretation guidance |
| `get_report` | The raw `results.json` payload |
| `get_diff` (alias `get_snapshot_diff`) | Baseline, current and diff PNGs, downscaled for model context |
| `list_baselines` | Committed baselines under `.testivai/baselines/` |
| `approve_snapshot` / `approve_all` | Promote reviewed snapshots to baselines — **only after a human says so** |

There's also a prompt, **`review-visual-changes`**, that walks a client through a
full review: summary → `explain_snapshot` per change → diff images when
ambiguous → a per-snapshot recommendation.

## What `explain_snapshot` actually returns

Real output, not a mock. The scenario: a designer changes one CSS custom
property — `--brand` from `#0e7490` to `#1f6feb` — in the
[example project](https://github.com/testivai/testivai-example). No markup
changes at all.

The one-line verdict:

```text
changed (1.13% pixels differ) — style-only change: 6 elements restyled with
identical DOM (body > header, body > main > section:nth-of-type(2) > div.row >
button.btn:nth-of-type(1), …); a real change, not noise — confirm it is
intended before approving
```

The evidence behind it:

```jsonc
{
  "name": "home",
  "status": "changed",
  "layers": {
    "pixel": {
      "diffPercent": 1.13,
      "regionCount": 5,
      "regions": [
        {
          "x": 0, "y": 0, "width": 98, "height": 165,
          "diffPixels": 8109, "diffPercent": 50.15,
          "classification": "change",
          "elements": [
            { "selector": "body > header > p", "role": "changed" },
            { "selector": "body > header",     "role": "changed" }
          ]
        },
        {
          "x": 234, "y": 438, "width": 116, "height": 38,
          "diffPixels": 3839, "diffPercent": 87.09,
          "classification": "change",
          "elements": [
            { "selector": "body > main > section:nth-of-type(2) > div.row > button.btn:nth-of-type(1)",
              "role": "changed" }
          ]
        }
        // … 3 more regions
      ]
    },
    "dom": {
      "changed": false,
      "noiseHint": false,
      "styleCheck": "mismatch",
      "styleChanges": {
        "count": 6,
        "elements": [
          "body > header",
          "body > main > section:nth-of-type(2) > div.row > button.btn:nth-of-type(1)",
          "body > main > section:nth-of-type(3) > div.cards > div.card:nth-of-type(1) > div.body:nth-of-type(2) > div.price"
        ]
      }
    }
  },
  "guidance": [
    "Computed styles changed on 6 element(s) … while the DOM stayed identical — a stylesheet-only change. This is REAL, not noise.",
    "Baseline approval is a human decision: propose, do not auto-approve."
  ]
}
```

Read what that gives a model that a pixel percentage doesn't. `1.13% of pixels
differ` is unactionable. This says: nothing structural changed, six specific
elements were restyled, and the affected selectors are the header, the primary
buttons, and the price labels on every card — which is exactly the blast radius
of a brand-colour token. A model can now tell you *"you changed the brand token;
it hit the header, the primary buttons and the card prices — intended?"* rather
than *"something moved."*

## What the model adds (and what it doesn't)

Worth being precise, because this is where visual testing tools usually
overclaim.

**The detection is not AI.** Everything in the payload above — the diff regions,
the selector attribution, `dom.changed`, `styleCheck: "mismatch"`, the list of
restyled elements — is produced by deterministic comparison. Same input, same
output, every run, no tokens spent, no network call. If you never connect a model
at all, you still get every one of those signals in `results.json` and the HTML
report.

**The model adds interpretation**, which is a genuinely different job:

| | |
|---|---|
| **Intent** | The tool says *six elements restyled, DOM identical, here are the selectors*. A model that can see your diff says *you changed the brand token; it reached the header, the primary buttons and every card price*. It connects the change to the edit you just made. |
| **Triage** | Thirty changed snapshots is a reading task. The server already groups what is decidable ([below](#what-the-server-groups)); a model goes further — *these twenty-eight are the same token change, these two are something else* — by connecting different restyled elements on different pages to one edit, and puts the two in front of you first. |
| **Explanation** | Turning the evidence into a sentence a reviewer understands, in a PR comment or in your editor. |
| **Self-correction** | An agent that just edited the UI can check whether it changed anything it didn't intend, and fix it before you ever see it. |

### What the server groups

`get_visual_results` opens with a **Grouped by identical signal** section when
at least two changed snapshots share one of these signals, chosen in this
order (a snapshot joins at most one group):

| Signal | Grouped when | What it does not tell you |
|---|---|---|
| Style-only change | identical DOM and **exactly the same set of restyled elements** | whether the new style values are the same: the grouping is on which elements changed style |
| Page shift | the same displacement: identical `dy` and `belowY` | whether the same content caused it |
| Render noise | the noise hint, split by whether the computed styles were compared (`styleCheck: "match"`) or not | anything the DOM and style signals don't cover |

It never groups structural DOM changes, snapshots without DOM data, or
style-only changes with more than 10 restyled elements (witness lists only
the first 10, so those lists can't be compared exactly; the section names
them instead). Passed, auto-passed and new snapshots are left out. Every
snapshot keeps its own verdict line below the groups, unchanged.

This under-groups on purpose: one token change usually restyles a different
set of elements on each page, so pages that differ in structure land in
different groups, or none. Connecting those to the one edit that caused them
is the model's job.

**What the model does not do is decide whether something changed.** That's
already settled before it's involved. This matters for trust: a hallucinating
model can produce a bad *explanation*, but it cannot invent a regression or hide
one, because it isn't in the detection path.

Nor does it decide what gets approved: it carries out an approval only when a human asks for one. See [the approval rule](#the-approval-rule).

## The approval rule

`approve_snapshot` and `approve_all` exist so that a human can say "approve it"
in conversation and have the agent carry it out. They are **not** for an agent
deciding on its own. In Claude Code the client enforces this: it asks you to
confirm every approve call (see
[Review and approve in Claude Code](#review-and-approve-in-claude-code)).

Approving a baseline rewrites the definition of "correct," so an agent that
approves its own work can launder a regression into the new baseline. The
guardrails are in the wording the model actually reads: both tool descriptions
say to invoke them only after a reviewer has confirmed, the
`review-visual-changes` prompt repeats it, and every `get_visual_results`
response ends with the same instruction.

Human-shaped approval paths stay available either way: `npx testivai approve`
locally, or a `/testivai approve` comment on the pull request, which verifies the
commenter has write access.

## Instructions file (works with any agent)

If your agent isn't MCP-capable, paste into `AGENTS.md` / `CLAUDE.md` /
`.cursorrules`:

```markdown
## Visual verification
After changing UI code, run the visual tests, then read visual-report/results.json:
- status "changed" + dom.changed true → real structural change; compare against intent
- status "changed" + dom.styleCheck "mismatch" → style-only change; real, not noise
- status "changed" + dom.noiseHint true → likely render noise; mention, don't block
- status "new" → no baseline yet; tell the human
Never run `testivai approve` yourself — approval is a human decision.
```

→ [Agent guide](./guides/ai-agents.md) · [Philosophy](./philosophy.md)
