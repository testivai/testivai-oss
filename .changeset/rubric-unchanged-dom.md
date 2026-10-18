---
"@testivai/mcp": patch
---

The triage rubric (the `triage-visual-diff` prompt, shared with the review action) now says what an unchanged DOM rules out. No element, attribute or text differs between the baseline and the current capture, and the baseline is the last approved capture, which can already contain the change under test. So a text or markup edit in the change never explains an identical-DOM diff, even where its regions sit on text the change edited. Only something the DOM does not record can: a stylesheet change the style check does not cover, an image, a font or another asset, or the capture. When the change touched none of those, the verdict is a glitch or a possible bug, not an intended change. Found when the CI review of testivai-site#20 called a re-capture of already-approved copy an intended change because the pull request edited that text.
