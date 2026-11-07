---
"@testivai/witness": patch
---

`testivai init-claude` replaces a `/testivai` skill that an earlier release wrote and nobody edited (recognised by its SHA-256, listed in `PREVIOUS_SKILL_SHA256`), without `--force`: upgrading from 2.7.0 is `npx testivai init-claude`. A file that differs from every released version is still kept unless `--force`, and the message now says so.
