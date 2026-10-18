# @testivai/mcp

MCP (Model Context Protocol) server that gives AI coding agents eyes on your
visual regression results. The agent changes UI code, runs your test suite,
then uses these tools to find out **what actually changed on screen** — and
whether it is a real change, likely render noise, or a case the DOM and style
signals cannot settle.

## Tools

| Tool | What it does |
|---|---|
| `get_visual_results` | Reads `visual-report/results.json` and returns a one-line verdict per snapshot: passed (an auto-passed diff says which configured criterion passed it) / size changed (the current capture's dimensions differ from the baseline's: a taller or shorter page is read with the DOM summary and the page shift, and with an identical DOM it is the same content laid out differently, not content added; a width change is the viewport or device scale, not the page; every padded pixel counts as changed, so it is never passed and never noise) / likely render noise (the DOM and computed styles both match and the diff is small and scattered; still not proof) / concentrated in one area or large (the DOM and computed styles match, but every diff region fits in a box covering at most a third of the page, or over 1% of pixels differ: a bad capture or a change the style check does not cover, such as size, overflow, transform or an image, so compare the images before approving) / style-only change (identical DOM, different computed styles: a real change) / structural change (with the DOM summary) / styles not compared (identical DOM, style check unavailable: could be render noise or a stylesheet-only change, so compare the images before approving). Snapshots that share an identical signal (style-only change on the same elements, the same page shift, identical DOM with styles not compared, a large spread-out diff, likely render noise) are grouped first; a diff concentrated in one area is never grouped. Each missing baseline (committed, but no capture this run) gets its own line (several share one verdict line, so a partial run stays short), with nothing to approve: an intended removal deletes the baseline directory. It ends with the paths to open the HTML report and each diff image |
| `explain_snapshot` | Layered evidence for one snapshot: pixel regions and the shape of the diff (`layers.pixel.shape`: scattered, concentrated or large), element attribution (which selectors shifted vs changed, whole-page shift), the DOM/style signal, and interpretation guidance; for a missing baseline, status `missing`, the committed baseline files and what to check instead |
| `get_report` | The raw `results.json` payload, for agents that parse structured data |
| `get_diff` (alias `get_snapshot_diff`) | Returns the baseline, current, and diff **images** for one snapshot so the agent can see the change: the full page downscaled to fit model context (it shows where the changes are), then, when it had to be downscaled, each changed region cropped at native scale with 32 px around it and as wide as the page (up to 1280 px), so text, wrapping and clipping stay readable on a tall full-page capture (up to 3 crops per call, each at most 1280×1024 px and 2,000,000 px in all; nearby regions share a crop, changes come before shifts, a wider area is sampled at 1/2 scale or smaller, a taller one shows its top rows, and after a size change each capture is cut to its own bounds). `region` (an index the response lists), or `y` and `height` (a full-width band), return only that crop; for a missing baseline, the committed baseline image only |
| `list_baselines` | Lists the committed baselines under `.testivai/baselines/` |
| `approve_snapshot` / `approve_all` | Promote reviewed captures to committed baselines (same as `testivai approve`), **only after a human confirms** |

The server also ships two prompts. `review-visual-changes` walks the agent
through a full review: summary, `explain_snapshot` per change, diff images when
the evidence is ambiguous, and a recommendation per snapshot.
`triage-visual-diff` (optional `snapshot` and `intent` arguments) sorts each
diff, and each missing baseline, into glitch, intended change, bug or possible
bug, with the evidence and a next step; a changed DOM or changed computed
styles is never a glitch, and neither is a missing baseline. The
same rules run in CI with the
[`testivai/testivai-oss/review@v1`](https://github.com/testivai/testivai-oss/blob/main/docs/github-action.md#ai-triage-of-every-diff)
action.

### Approval is a human decision

`approve_snapshot` and `approve_all` exist so a human who has looked at a diff
can say "approve it" in the conversation and have the agent carry it out. They
are not for the agent to decide on its own: approving rewrites what "correct"
means, so an agent that approves its own change can launder a regression into
the baseline. Both tool descriptions, the `review-visual-changes` prompt, and
every `get_visual_results` response say so. After approving, commit
`.testivai/baselines/`.

In Claude Code the client enforces this: both approve tools are marked
`anthropic/requiresUserInteraction`, so Claude Code asks you on every approve
call, even in auto-approving permission modes. To turn that off, start the
server with `--no-approval-prompt` or set `"mcpApprovalPrompt": false` in
`.testivai/config.json` (the flag wins); the approve tools then follow your
client's own permission settings. Walkthrough:
[Review and approve in Claude Code](https://github.com/testivai/testivai-oss/blob/main/docs/mcp.md#review-and-approve-in-claude-code).

The other approval paths stay available: `npx testivai approve <name>` locally,
or a `/testivai approve <name>` comment on the pull request.

## Setup

### Claude Code

```bash
claude mcp add testivai -- npx -y @testivai/mcp
```

### Cursor / other MCP clients

```jsonc
// .cursor/mcp.json (or your client's equivalent)
{
  "mcpServers": {
    "testivai": { "command": "npx", "args": ["-y", "@testivai/mcp"] }
  }
}
```

The server reads the project from its working directory (pass `--root <path>`
to override) and respects `reportDir` from `.testivai/config.json`.

## Typical agent flow

1. Agent edits UI code.
2. Agent runs `npx playwright test` (the TestivAI reporter captures + diffs).
3. Agent calls `get_visual_results` and sees, for example, `homepage: changed
   (4.20% pixels differ) and the DOM changed (2 added, 1 removed, 0 attribute
   changes) — a real structural change; confirm it is intended before approving`.
4. Agent calls `explain_snapshot homepage` for the evidence, and `get_diff
   homepage` to look at the images (the full page, then the changed regions at
   native scale), then confirms the change matches the task (or fixes its own
   regression).
5. Agent reports to the human: what changed, whether it looks intended, and
   which snapshots need approval. If the human says to approve, the agent calls
   `approve_snapshot`; otherwise the human approves with `npx testivai approve`
   or `/testivai approve` on the PR.

Local mode only — no account, no API key, nothing leaves the machine.

Full integration guide (instructions-file level, MCP level, zero-test-suite apps, real transcript): [docs/guides/ai-agents.md](https://github.com/testivai/testivai-oss/blob/main/docs/guides/ai-agents.md)
