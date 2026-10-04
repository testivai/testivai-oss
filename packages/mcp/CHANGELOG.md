# @testivai/mcp

## 0.6.0

### Minor Changes

- b2892e5: Turn off the per-call approval prompt when you want to. By default `approve_snapshot` and `approve_all` make Claude Code ask you on every call. Start the MCP server with `--no-approval-prompt`, or set `"mcpApprovalPrompt": false` in `.testivai/config.json`, and the approve tools follow your client's own permission settings instead (allow rules, "don't ask again", auto modes). The flag wins over the config key, and `--approval-prompt` turns the prompt back on. `@testivai/witness` now recognises `mcpApprovalPrompt` as a boolean config key instead of warning that it is unknown.
- a3e909d: Approve visual changes from Claude Code, with the approval always coming from you. `approve_snapshot` and `approve_all` now carry `anthropic/requiresUserInteraction` in `tools/list`, so Claude Code (v2.1.214 or later) shows its permission prompt on every approve call, even in `acceptEdits`, `auto` and `bypassPermissions` modes, with no "don't ask again"; other MCP clients ignore the marker. The `get_visual_results` footer still tells the agent not to approve on its own, and now names `approve_snapshot` for when the human confirms a change in the conversation, alongside `npx testivai approve` and `/testivai approve` on the PR.
- 067eecc: `get_visual_results` now groups snapshots that share an identical signal before listing them one by one: a style-only change on exactly the same set of elements, the same page shift (`dy` and `belowY`), or the same kind of render noise (styles compared and matching, or not compared). The grouping is deterministic and does not depend on input order. It never groups structural DOM changes, snapshots without DOM data, or style-only changes whose element list witness truncated at 10 (those are named instead), and each group says exactly what it was based on: for a style-only group, which elements changed style, not the new style values. The per-snapshot verdict lines are unchanged.
- 26f982a: `get_visual_results` now ends with the paths you can open to see what changed: the HTML report, each changed snapshot's diff image, and each new snapshot's capture, as absolute paths. MCP clients give images to the model, but may not show them to you; these paths let you open them from the conversation. The per-snapshot verdict lines are unchanged, and only files that exist inside the report directory are listed.

### Patch Changes

- 1e83349: The agent-facing text no longer contradicts the verdicts. The `get_visual_results` description, which the model reads before calling the tool, said "DOM-identical diffs are likely render noise", but since witness 1.6.0 a diff with an identical DOM and different computed styles is a real style-only change, and the verdict already said so. The description now ties noise to the DOM and the computed styles both matching. The noise verdict, and the matching `explain_snapshot` guidance, now say the DOM and computed styles both matched when the style check ran, and say the styles were not compared when it could not run (no comparable style digests), instead of implying a match that was never checked.
- Updated dependencies [b2892e5]
- Updated dependencies [b380f3c]
  - @testivai/witness@2.1.0

## 0.5.10

### Patch Changes

- Updated dependencies [fcd39f8]
  - @testivai/witness@2.0.2

## 0.5.9

### Patch Changes

- Updated dependencies [e289450]
  - @testivai/witness@2.0.1

## 0.5.8

### Patch Changes

- Updated dependencies [5af0816]
- Updated dependencies [ec92541]
  - @testivai/witness@2.0.0

## 0.5.7

### Patch Changes

- 01232e8: When no report exists, the MCP server now explains why instead of always saying "run the visual tests first" — which is wrong on a sharded CI node, where the tests did run but a shard captures without comparing. It distinguishes a capture-only shard (naming which), captures that were never compared, and a project where nothing ran at all.
- Updated dependencies [f80f6c6]
- Updated dependencies [09eafd4]
- Updated dependencies [6fdc1db]
  - @testivai/witness@1.13.0

## 0.5.6

### Patch Changes

- 1efe97f: Fixes the agent-facing verdict for style-only changes. When the DOM was identical but computed styles differed, `explain_snapshot` and `get_visual_results` reported "no DOM data; treat as needing human review" — contradicting the HTML report, which correctly calls it a style-only change, and hiding the signal agents most need. Verdicts now say "style-only change: N elements restyled with identical DOM" with the affected selectors, and a captured-but-unremarkable DOM no longer claims to be missing. Adds a dedicated MCP documentation page.
- Updated dependencies [ffc2171]
- Updated dependencies [90109b5]
- Updated dependencies [2a37518]
- Updated dependencies [750562e]
- Updated dependencies [1efe97f]
- Updated dependencies [c9b01a6]
- Updated dependencies [003765d]
- Updated dependencies [cba53b5]
- Updated dependencies [0eb2adb]
- Updated dependencies [9aa0f14]
- Updated dependencies [8997ccd]
  - @testivai/witness@1.12.0

## 0.5.5

### Patch Changes

- Updated dependencies [b70ebd9]
  - @testivai/witness@1.11.1

## 0.5.4

### Patch Changes

- Updated dependencies [f94048d]
- Updated dependencies [8de6c13]
  - @testivai/witness@1.11.0

## 0.5.3

### Patch Changes

- Updated dependencies [271f30d]
  - @testivai/witness@1.10.0

## 0.5.2

### Patch Changes

- 381279b: `list_baselines` (and the approve tools via the shared store) now honor the `baselinesDir` config, including the new `{platform}` token — agreeing with the CLI's resolution.
- Updated dependencies [381279b]
  - @testivai/witness@1.9.0

## 0.5.1

### Patch Changes

- Updated dependencies [139d28d]
- Updated dependencies [1c4c883]
  - @testivai/witness@1.8.0

## 0.5.0

### Minor Changes

- e37eb33: New `explain_snapshot(name)` tool: a layered evidence bundle for one snapshot — pixel regions with bounding boxes, element attribution (which selectors shifted vs changed, whole-page shift detection), the DOM/style signal, and interpretation guidance. Paired with a new `review-visual-changes` prompt that walks any MCP client through a full review (summary → explanations → diff images → per-snapshot recommendation). The client's own model writes the narrative; the server ships evidence, not an LLM.

### Patch Changes

- Updated dependencies [fa0deb5]
- Updated dependencies [e37eb33]
  - @testivai/witness@1.7.1

## 0.4.0

### Minor Changes

- 5bfdca5: The MCP server can now drive the full agent loop without scraping ANSI output:

  - `approve_snapshot(name)` and `approve_all` promote captures in `.testivai/temp/` to committed baselines, reusing the same `BaselineStore` as the CLI (identical semantics + undo).
  - `get_report` returns the raw `results.json` payload (summary + per-snapshot status, diff %, DOM signal, region→selector attribution) for structured parsing.
  - `get_diff` is added as the canonical name for the diff-image tool; `get_snapshot_diff` remains as an alias.

  Approval tools are gated by intent in their descriptions: only approve changes a reviewer has confirmed are intended.

### Patch Changes

- Updated dependencies [5bfdca5]
- Updated dependencies [9db57c2]
  - @testivai/witness@1.7.0

## 0.3.0

### Minor Changes

- 767385e: The `get_snapshot_diff` tool now downscales returned diff images to a max 1024px longest edge (integer-stride nearest-neighbour, via `pngjs`). When an image was downscaled the text label includes the original dimensions (e.g. "baseline (downscaled from 1280x7669):"). Images that already fit within 1024px are returned unchanged.

### Patch Changes

- 9bbbd58: Add official MCP Registry metadata: `mcpName` (`ai.testiv/mcp`, DNS-verified namespace) in package.json and a `server.json` descriptor, so the server can be listed on registry.modelcontextprotocol.io.

## 0.2.0

### Minor Changes

- fed09cf: New package: MCP (Model Context Protocol) server exposing TestivAI visual regression results to AI coding agents. Read-only v1 with three tools: `get_visual_results` (per-snapshot verdicts combining pixel diff + DOM signal), `get_snapshot_diff` (returns baseline/current/diff images so the agent can see the change), and `list_baselines`. No approve tool by design — baseline promotion stays a human decision.
