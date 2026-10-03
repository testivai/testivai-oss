---
"@testivai/mcp": patch
---

The agent-facing text no longer contradicts the verdicts. The `get_visual_results` description, which the model reads before calling the tool, said "DOM-identical diffs are likely render noise", but since witness 1.6.0 a diff with an identical DOM and different computed styles is a real style-only change, and the verdict already said so. The description now ties noise to the DOM and the computed styles both matching. The noise verdict, and the matching `explain_snapshot` guidance, now say the DOM and computed styles both matched when the style check ran, and say the styles were not compared when it could not run (no comparable style digests), instead of implying a match that was never checked.
