# @testivai/mcp

MCP (Model Context Protocol) server that gives AI coding agents eyes on your
visual regression results. The agent changes UI code, runs your test suite,
then uses these tools to find out **what actually changed on screen** — and
whether it's real or just render noise.

## Tools

| Tool | What it does |
|---|---|
| `get_visual_results` | Reads `visual-report/results.json` and returns a one-line verdict per snapshot: passed / likely render noise (the DOM and computed styles both match) / style-only change (identical DOM, different computed styles: a real change) / structural change (with the DOM summary) |
| `explain_snapshot` | Layered evidence for one snapshot: pixel regions, element attribution (which selectors shifted vs changed, whole-page shift), the DOM/style signal, and interpretation guidance |
| `get_report` | The raw `results.json` payload, for agents that parse structured data |
| `get_diff` (alias `get_snapshot_diff`) | Returns the baseline, current, and diff **images** for one snapshot, downscaled to fit model context, so the agent can see the change |
| `list_baselines` | Lists the committed baselines under `.testivai/baselines/` |
| `approve_snapshot` / `approve_all` | Promote reviewed captures to committed baselines (same as `testivai approve`), **only after a human confirms** |

The server also ships a prompt, `review-visual-changes`, that walks the agent
through a full review: summary, `explain_snapshot` per change, diff images when
the evidence is ambiguous, and a recommendation per snapshot.

### Approval is a human decision

`approve_snapshot` and `approve_all` exist so a human who has looked at a diff
can say "approve it" in the conversation and have the agent carry it out. They
are not for the agent to decide on its own: approving rewrites what "correct"
means, so an agent that approves its own change can launder a regression into
the baseline. Both tool descriptions, the `review-visual-changes` prompt, and
every `get_visual_results` response say so. After approving, commit
`.testivai/baselines/`.

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
   homepage` to look at the images, then confirms the change matches the task
   (or fixes its own regression).
5. Agent reports to the human: what changed, whether it looks intended, and
   which snapshots need approval. If the human says to approve, the agent calls
   `approve_snapshot`; otherwise the human approves with `npx testivai approve`
   or `/testivai approve` on the PR.

Local mode only — no account, no API key, nothing leaves the machine.

Full integration guide (instructions-file level, MCP level, zero-test-suite apps, real transcript): [docs/guides/ai-agents.md](https://github.com/testivai/testivai-oss/blob/main/docs/guides/ai-agents.md)
