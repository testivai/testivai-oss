---
"@testivai/witness": minor
---

`testivai init-claude` adds a `/testivai` command for Claude Code to the project (`.claude/skills/testivai/SKILL.md`): `status` summarises `visual-report/results.json`, `report` points to the report, and `approve <name...|--all>` runs `testivai approve` on the local captures, or with `--pr` comments `/testivai approve` on the pull request. It works in the terminal, the desktop app and claude.ai/code cloud sessions, which load project skills but no plugins. Only a person typing `/testivai` runs it (`disable-model-invocation: true`). A changed file is kept unless `--force`. Also exported: `installClaudeSkill`, `TESTIVAI_SKILL`, `CLAUDE_SKILL_PATH`.
