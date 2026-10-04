---
"@testivai/mcp": minor
---

Approve visual changes from Claude Code, with the approval always coming from you. `approve_snapshot` and `approve_all` now carry `anthropic/requiresUserInteraction` in `tools/list`, so Claude Code (v2.1.214 or later) shows its permission prompt on every approve call, even in `acceptEdits`, `auto` and `bypassPermissions` modes, with no "don't ask again"; other MCP clients ignore the marker. The `get_visual_results` footer still tells the agent not to approve on its own, and now names `approve_snapshot` for when the human confirms a change in the conversation, alongside `npx testivai approve` and `/testivai approve` on the PR.
