---
"@testivai/mcp": patch
---

`zod` 4.6.6 or later (was 3.25): every 3.x release is affected by GHSA-mrhx-c7xc-m3w5 (memory exhaustion while validating oversized constrained collections), so `npm audit --audit-level=high` failed in any project that installs `@testivai/mcp`. The tools, their arguments and their validation are unchanged. Two cosmetic differences in the advertised input schemas: integer arguments (`region`, `y`, `height`) now carry an explicit `maximum`, and tool input objects no longer advertise `additionalProperties: false` (unknown keys are still dropped, as before).
