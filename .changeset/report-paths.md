---
"@testivai/mcp": minor
---

`get_visual_results` now ends with the paths you can open to see what changed: the HTML report, each changed snapshot's diff image, and each new snapshot's capture, as absolute paths. MCP clients give images to the model, but may not show them to you; these paths let you open them from the conversation. The per-snapshot verdict lines are unchanged, and only files that exist inside the report directory are listed.
