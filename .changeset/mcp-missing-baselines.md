---
"@testivai/mcp": minor
---

Cover missing baselines: names in results.json `missingBaselines`, committed baselines that got no capture this run (the test was removed, renamed or skipped, or failed before it captured). `get_visual_results` counts them in its header and gives each one a verdict line saying there is nothing to approve and how to accept a removal; `explain_snapshot` returns status `missing` with the committed baseline files (found through `baselinesDir`, `{platform}` included) and what to check instead; `get_diff` returns the committed baseline screenshot only. The `triage-visual-diff` rubric gets a row for them (intended change, bug or possible bug, never a glitch), its next steps say an intended removal deletes the baseline directory because approving does nothing, and `review-visual-changes` no longer stops when the only finding is a missing baseline. A name is looked up only when results.json lists it as missing, and never resolves outside the baselines directory.
