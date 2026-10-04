---
"@testivai/mcp": minor
"@testivai/witness": minor
---

Turn off the per-call approval prompt when you want to. By default `approve_snapshot` and `approve_all` make Claude Code ask you on every call. Start the MCP server with `--no-approval-prompt`, or set `"mcpApprovalPrompt": false` in `.testivai/config.json`, and the approve tools follow your client's own permission settings instead (allow rules, "don't ask again", auto modes). The flag wins over the config key, and `--approval-prompt` turns the prompt back on. `@testivai/witness` now recognises `mcpApprovalPrompt` as a boolean config key instead of warning that it is unknown.
