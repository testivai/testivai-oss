---
"@testivai/mcp": patch
---

The MCP server no longer tells agents that an identical-DOM diff is likely render noise when the computed styles were not compared. `get_visual_results`, `explain_snapshot`, the change groups and the `review-visual-changes` prompt give that case its own "styles not compared" verdict and send the agent to the images (`get_diff`) before approving. An auto-passed snapshot names the criterion that passed it, a passed snapshot no longer gets noise guidance, and a DOM change that also restyled elements is never described as "the DOM stayed identical".
