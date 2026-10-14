---
"@testivai/mcp": minor
---

New `triage-visual-diff` prompt: the model sorts each changed snapshot into glitch (the capture or environment, not the page), intended change, bug or possible bug, from `explain_snapshot`, the `get_diff` images and what the change was meant to do (optional `snapshot` and `intent` arguments). A changed DOM or changed computed styles is never a glitch, an identical DOM whose styles were not compared is not called one from the DOM alone, and a large or local DOM-identical diff is a bad capture (say which image) only when nothing the change touched could have caused it, since the style check does not cover every CSS property. The prompt never approves. `prompts/get` also accepts a request with no `arguments` object, which MCP allows and the SDK rejected for prompts with optional arguments. The same rules run in CI through the new `testivai/testivai-oss/review@v1` action.
