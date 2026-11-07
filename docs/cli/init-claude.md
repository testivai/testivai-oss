---
sidebar_position: 7
title: testivai init-claude
---

# `testivai init-claude`

Adds a `/testivai` command for [Claude Code](https://claude.com/claude-code)
to your project, as a project skill at `.claude/skills/testivai/SKILL.md`.
Commit the file, and `/testivai` works wherever Claude Code opens the
repository: the terminal, the desktop app, and cloud sessions on
claude.ai/code. Cloud sessions load a repository's skills but no plugins, so
the [`testivai-report` plugin](https://github.com/testivai/testivai-oss/tree/main/plugins/claude-code/testivai-report/README.md)
is not there; this skill is.

## Usage

```bash
npx testivai init-claude [options]
```

| Flag | Description |
|---|---|
| `-f, --force` | Replace the file when it differs from this version |
| `--json` | Print `{ "status", "path" }` to stdout |

`status` is `created`, `unchanged` (already this version), `updated` (replaced)
or `conflict`. After upgrading `@testivai/witness`, run it again to pick up a
newer skill: a skill an earlier release wrote, unedited, is replaced without
`--force` (`@testivai/witness` 2.7.1 and later). A file you changed is
kept and the command exits with code 1; `--force` replaces it.

Prefer not to run it? Copy [`docs/claude-code/testivai/SKILL.md`](../claude-code/testivai/SKILL.md)
to `.claude/skills/testivai/SKILL.md` yourself. It is the same file.

## The command

| You type | What happens |
|---|---|
| `/testivai status` | A summary of `visual-report/results.json`: counts, each changed snapshot and what its fields say (with any restyled elements and page shift), missing baselines. |
| `/testivai report [folder]` | Points you to `/testivai-report` when the plugin is installed. Otherwise runs `npx testivai report --share` and shows `visual-report/share.html`, the report with its screenshots inside the page, so it shows in the app's side panel. Never when `shareUploadCommand` is set (that would upload it): then it gives the path of `index.html`. |
| `/testivai approve <name...\|--all>` | With the captures in this checkout (`.testivai/temp/`), runs [`npx testivai approve`](./approve.md) for those names. It does not commit. |
| `/testivai approve <name...\|--all> --pr` | Comments `/testivai approve <name...\|--all>` on the branch's pull request, for the [approve action](../github-action.md#approving-changes-from-pr-feedback) to do it. With no way to comment, it gives you the line to post. |

Approving stays a human decision. The skill sets
`disable-model-invocation: true`, so Claude cannot run it on its own: only
typing `/testivai` does. A bare `/testivai approve` approves nothing and asks
which snapshots you mean. Without `--pr`, a session with no local captures
uses the pull request if the branch has one.

The approve action acts only for a commenter with write access to the
repository. When Claude posts the comment, the commenter is whoever its
GitHub access acts as.
