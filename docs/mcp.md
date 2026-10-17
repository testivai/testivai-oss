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
   with `get_diff` when the evidence is ambiguous (always when the styles were
   not compared), and recommends approve, investigate, or likely noise for
   each snapshot. "Likely noise" is only for an identical DOM whose computed
   styles were compared and match, and whose diff is small and scattered: a
   diff concentrated in one area, or over 1% of pixels, gets its own verdict
   (see [Matching styles are not always noise](#matching-styles-are-not-always-noise)).
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
| `get_visual_results` | Every snapshot with a one-line verdict phrased for decisions, opened by [groups of snapshots that share an identical signal](#what-the-server-groups) when there are any, then the paths to open: the HTML report, each changed snapshot's diff image, each new snapshot's capture. Each missing baseline (committed, but no capture this run) gets its own line too (several share one verdict line, so a partial run stays short), with nothing to approve: an intended removal deletes the baseline directory |
| `explain_snapshot` | Layered evidence for one snapshot — pixel regions, element attribution, DOM/style signal, interpretation guidance; for a missing baseline, status `missing`, the committed baseline files and what to check instead |
| `get_report` | The raw `results.json` payload |
| `get_diff` (alias `get_snapshot_diff`) | Baseline, current and diff PNGs, downscaled for model context; for a missing baseline, the committed baseline image only, since there is no current capture |
| `list_baselines` | Committed baselines under `.testivai/baselines/` |
| `approve_snapshot` / `approve_all` | Promote reviewed snapshots to baselines — **only after a human says so** |

There are also two prompts. **`review-visual-changes`** walks a client through a
full review: summary → `explain_snapshot` per change → diff images when
ambiguous → a per-snapshot recommendation. **`triage-visual-diff`** sorts each
diff into glitch, intended change, bug or possible bug ([below](#triage-a-diff-glitch-intended-change-bug-or-possible-bug)).

## Triage a diff: glitch, intended change, bug or possible bug

A pixel diff alone can't tell a rendering glitch from a regression. The
`triage-visual-diff` prompt has the model decide, per snapshot, from the
signals, the images and what the change was meant to do:

| Verdict | Meaning |
|---|---|
| **glitch** | The page did not change: render noise, a bad capture (the baseline's or the current one), or a font or other resource that failed to load |
| **intended change** | The page changed, and it matches what the change under test was meant to do |
| **bug** | The page changed in a way the change was not meant to make, or the result looks broken |
| **possible bug** | The page really changed, but the evidence can't settle whether that was meant, or it is incomplete (styles not compared, no DOM data); the model says what to check |

In Claude Code, type `/testivai:triage-visual-diff` (or
`/mcp__testivai__triage-visual-diff`). Both arguments are optional:

- `snapshot`: triage one snapshot or missing baseline; empty triages every
  changed or new snapshot and every missing baseline.
- `intent`: what the change was meant to do, for example the pull request
  description. Empty has the model look for it in the conversation, the PR or
  the branch's diff; with no statement of intent anywhere it calls a real
  change a possible bug rather than guess.

The rules it gives the model:

- A changed DOM or changed computed styles (`styleCheck: "mismatch"`) is never
  a glitch.
- An identical DOM whose styles were not compared (`styleCheck: "unavailable"`
  or missing) is not called a glitch from the DOM alone; the images decide.
- Render noise is small and scattered. A larger or local diff with an
  identical DOM and matching styles is a bad capture or a change the style
  check cannot see (it does not cover size, overflow, position, transform and
  some other properties, or images). The model calls it a glitch only when
  nothing the change touched could have caused it, and then says which image
  is wrong. A bad baseline has to be replaced from a capture two runs agree
  on.
- A missing baseline (committed, but no capture this run: `missingBaselines`
  in `results.json`) is never a glitch: the model reads the change under test
  for a removed or renamed test, or one broken before its capture, and
  otherwise calls it a possible bug and says to check the test run's log, since
  the report cannot say why nothing was captured. Approving does nothing for a
  missing baseline: an intended removal deletes its baseline directory in the
  same change (for example `git rm -r .testivai/baselines/<name>`).
- It reports a verdict, confidence, evidence and next step per snapshot, and
  never calls `approve_snapshot` or `approve_all`.

Other MCP clients list it as a prompt too. To run the same triage on every
pull request in CI, use the [`testivai/testivai-oss/review@v1` action](./github-action.md#ai-triage-of-every-diff).

## What `explain_snapshot` actually returns

Real output, not a mock, from the demo in the
[example project](https://github.com/testivai/testivai-example): `npm run demo`
applies one change to each of its three pages, and
`npx -y @testivai/mcp --root .demo` serves the results. On the `buttons` page
the change is CSS only: every `.btn` becomes pill-shaped
(`border-radius: 999px`) and `.btn-primary` turns violet (`#7c3aed`). No markup
changes at all.

The one-line verdict:

```text
changed (2.33% pixels differ) — style-only change: 8 elements restyled with
identical DOM (body > main > section:nth-of-type(1) > div.row:nth-of-type(1) >
button.btn:nth-of-type(1), body > main > section:nth-of-type(1) >
div.row:nth-of-type(1) > button.btn:nth-of-type(2), body > main >
section:nth-of-type(1) > div.row:nth-of-type(1) > button.btn:nth-of-type(3), …);
a real change, not noise — confirm it is intended before approving
```

The evidence behind it, trimmed: the repeated verdict, three of the five
regions and the `changedSelectors` list are left out, and percentages are
rounded.

```jsonc
{
  "name": "buttons",
  "status": "changed",
  "layers": {
    "pixel": {
      "diffPercent": 2.33,
      "regionCount": 5,
      "regions": [
        {
          "x": 234, "y": 299, "width": 269, "height": 47,
          "diffPixels": 9082, "diffPercent": 71.83,
          "elements": [
            { "selector": "body > main > section:nth-of-type(1) > div.row:nth-of-type(2) > button.btn:nth-of-type(2)",
              "role": "changed" },
            { "selector": "body > main > section:nth-of-type(1) > div.row:nth-of-type(2)", "role": "changed" },
            { "selector": "body > main > section:nth-of-type(1)", "role": "changed" }
          ],
          "classification": "change"
        },
        {
          "x": 585, "y": 246, "width": 137, "height": 39,
          "diffPixels": 3943, "diffPercent": 73.8,
          "elements": [
            { "selector": "body > main > section:nth-of-type(1) > div.row:nth-of-type(1) > button.btn:nth-of-type(4)",
              "role": "changed" },
            { "selector": "body > main > section:nth-of-type(1) > div.row:nth-of-type(1)", "role": "changed" },
            { "selector": "body > main > section:nth-of-type(1)", "role": "changed" }
          ],
          "classification": "change"
        }
        // … 3 more regions: buttons 1 and 3 of the first row, and the signup
        // form's button.btn
      ]
    },
    "element": {
      "pageShift": null,
      "shiftedSelectors": [],
      "changedSelectors": [ /* the 10 selectors named in the regions */ ]
    },
    "dom": {
      "changed": false,
      "summary": null,
      "noiseHint": false,
      "styleCheck": "mismatch",
      "styleChanges": {
        "count": 8,
        "elements": [
          "body > main > section:nth-of-type(1) > div.row:nth-of-type(1) > button.btn:nth-of-type(1)",
          "body > main > section:nth-of-type(1) > div.row:nth-of-type(1) > button.btn:nth-of-type(2)",
          "body > main > section:nth-of-type(1) > div.row:nth-of-type(1) > button.btn:nth-of-type(3)",
          "body > main > section:nth-of-type(1) > div.row:nth-of-type(1) > button.btn:nth-of-type(4)",
          "body > main > section:nth-of-type(1) > div.row:nth-of-type(2) > button.btn:nth-of-type(1)",
          "body > main > section:nth-of-type(1) > div.row:nth-of-type(2) > button.btn:nth-of-type(2)",
          "body > main > section:nth-of-type(1) > div.row:nth-of-type(2) > button.btn:nth-of-type(3)",
          "body > main > section:nth-of-type(2) > form.signup > button.btn"
        ]
      }
    }
  },
  "guidance": [
    "Computed styles changed on 8 element(s) (…) while the DOM stayed identical — a stylesheet-only change. This is REAL, not noise.",
    "Baseline approval is a human decision: propose, do not auto-approve."
  ]
}
```

Read what that gives a model that a pixel percentage doesn't. `2.33% of pixels
differ` is unactionable. This says: nothing structural changed, eight specific
elements were restyled, and every one of them is a `button.btn` — the seven in
the button rows and the one in the newsletter signup form — which is exactly
the blast radius of an edit to the shared `.btn` rule. A model can now tell you
*"you changed the button styles; every button on the page picked it up, the
signup form's included — intended?"* rather than *"something moved."*

The demo's other two pages exercise the other layers. On `products`, where one
card is dropped from the grid, the verdict is a real structural change
(`0 added, 6 removed, 0 attribute changes, 2 text changes`) with no page shift.
On `home`, a promo banner is inserted above the content. The one-line verdict
calls that structural too, since the banner is a new DOM node, and
`explain_snapshot` adds where to look:

```text
Everything at or below y=203 moved down by 73px (25 elements together) — the
signature of content inserted or removed above that line. Look there for the
root cause, not at the moved elements.
```

Captured from the example at
[`f8fe0cb`](https://github.com/testivai/testivai-example/commit/f8fe0cb) on
Linux with Chromium 141. On another OS, font set or browser build the pixel
numbers (percentages, region boxes) can differ slightly; the restyled
elements, the DOM summary and the kind of change come from the DOM and
computed styles, not from pixels.

### Matching styles are not always noise

The style check digests a fixed list of computed properties: colours, fonts,
borders, padding and margin, display, opacity, visibility and box-shadow. A
real change to size, overflow, position, transform, text decoration, filters,
pseudo-elements, or an image or other asset leaves the DOM identical and the
styles matching, and so does a bad capture (a torn render, text that did not
paint, a bad baseline). What tells those apart from render noise is the shape
of the diff, read from `diffPercent`, `totalPixels` and `regions`:

| Shape | When | Verdict |
|---|---|---|
| Scattered | at most 1% of pixels, and no regions or regions spread out (their combined bounding box covers more than a third of the page) | likely render noise; mention it, don't block |
| Concentrated | every region fits in a box covering at most a third of the page | not noise: a bad capture or a change the style check does not cover; compare the images (`get_diff`) before approving |
| Large | spread out, but over 1% of pixels | more than render noise usually changes: often fonts or rendering that differ between machines; compare the images |

`explain_snapshot` returns the shape as `layers.pixel.shape`, and for a
concentrated diff names the element every region maps to. On real runs of the
[example project](https://github.com/testivai/testivai-example), with the DOM
identical and the styles matching throughout:

| Diff | Pixels | Regions | Shape |
|---|---|---|---|
| `max-height` + `overflow: hidden` clipping one product card (a real bug) | 0.03% | 3, in 0.8% of the page | concentrated |
| one card's text did not paint (a bad current capture) | 0.14% | 1, in 1.1% of the page | concentrated |
| a 260px band of the baseline moved 24px (a bad baseline) | 2.07% | 1, in 18.8% of the page | concentrated |
| sixty glyph-edge pixels changed (anti-aliasing) | 0.006% | none | scattered |
| every text run re-rasterized (`--disable-font-subpixel-positioning`) | 0.85% | 20, over 37.8% of the page | scattered |
| a CI-made baseline against a local capture | 4.77% | 22, over 93% of the page | large |

`noiseAutoPass` applies the same rule: it never passes a concentrated diff.
The limit: a change to a class that repeats down a long page (an underline on
thirty product titles) spreads its regions as widely as text-rendering noise,
so a small one can still read as scattered.

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
| **Intent** | The tool says *eight elements restyled, DOM identical, here are the selectors*. A model that can see your diff says *you changed the shared `.btn` rule; it reached every button on the page, the signup form's included*. It connects the change to the edit you just made. |
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
| Styles not compared | identical DOM, styles not compared (`styleCheck: "unavailable"`, or no style check in older results; the two are grouped apart). Labelled *render noise or a stylesheet-only change, not ruled out*, never labelled noise | which of the two it is: compare the images |
| Large diff | identical DOM and matching styles, but over 1% of pixels differ, spread across the page. Labelled *more than render noise usually changes*, never labelled noise | whether it is the same cause: often fonts or rendering that differ between machines, sometimes a bad capture or a change the style check does not cover |
| Likely render noise | identical DOM, the computed styles compared and identical (`styleCheck: "match"`), and a small, scattered diff | anything the DOM, style and diff-shape signals don't cover |

It never groups structural DOM changes, snapshots without DOM data, diffs
concentrated in one area (each sits in its own place, so grouping two would
suggest one cause), or style-only changes with more than 10 restyled elements (witness lists only
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
`review-visual-changes` and `triage-visual-diff` prompts repeat it, and every `get_visual_results`
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
- status "changed" + dom.changed false + dom.styleCheck "mismatch" → style-only change; real, not noise
- status "changed" + dom.noiseHint true + dom.styleCheck "match", diffPercent at most 1, and no regions or regions spread out (their combined bounding box covers more than a third of the page, totalPixels) → likely render noise; mention, don't block
- status "changed" + dom.noiseHint true + dom.styleCheck "match" otherwise (every region within a box of at most a third of the page, or diffPercent over 1) → not noise: a bad capture or a change the style check does not cover (size, overflow, transform, images…); look at the diff before approving
- status "changed" + dom.noiseHint true + dom.styleCheck "unavailable" or missing → styles not compared: could be render noise or a stylesheet-only change; look at the diff before approving
- status "new" → no baseline yet; tell the human
Never run `testivai approve` yourself — approval is a human decision.
```

→ [Agent guide](./guides/ai-agents.md) · [Philosophy](./philosophy.md)
