---
"@testivai/witness": patch
---

Standalone captures (`testivai witness <url>`) are now deterministic. Chrome could hand back a stale frame for the full-page screenshot: the page measured correctly, but the pixels showed styles resolved against an earlier viewport, such as a collapsed `min-height: 100vh` hero or narrow-viewport media rules. The same unchanged page then flipped between two renders from run to run and was reported as changed. The capture now waits for the page to render a fresh frame first (bounded at one second).

Baselines approved with standalone mode before this release may hold the stale render. If a page shows as changed once after upgrading, open the report to confirm the new capture is the correct one, then approve it.
