---
"@testivai/mcp": minor
---

New `triage-visual-diff` prompt: the model sorts each changed snapshot into glitch (the capture or environment, not the page), intended change, bug or possible bug, from `explain_snapshot`, the `get_diff` images and what the change was meant to do (optional `snapshot` and `intent` arguments). A changed DOM or changed computed styles is never a glitch, an identical DOM whose styles were not compared is not called one from the DOM alone, and a large or local DOM-identical diff is treated as a bad capture to locate rather than noise. The prompt never approves. The same rules run in CI through the new `testivai/testivai-oss/review@v1` action.
