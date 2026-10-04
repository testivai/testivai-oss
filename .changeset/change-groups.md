---
"@testivai/mcp": minor
---

`get_visual_results` now groups snapshots that share an identical signal before listing them one by one: a style-only change on exactly the same set of elements, the same page shift (`dy` and `belowY`), or the same kind of render noise (styles compared and matching, or not compared). The grouping is deterministic and does not depend on input order. It never groups structural DOM changes, snapshots without DOM data, or style-only changes whose element list witness truncated at 10 (those are named instead), and each group says exactly what it was based on: for a style-only group, which elements changed style, not the new style values. The per-snapshot verdict lines are unchanged.
