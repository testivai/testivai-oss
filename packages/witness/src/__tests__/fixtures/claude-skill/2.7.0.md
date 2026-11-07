---
name: testivai
description: TestivAI visual regression tests. status summarises the last visual report, report shows it, approve <name|--all> accepts changed screenshots as the new baselines.
argument-hint: "status | report [folder] | approve <name|--all> [--pr]"
disable-model-invocation: true
allowed-tools: Read, Glob, Bash(npx testivai approve:*)
---

# /testivai

The person typed: `/testivai $ARGUMENTS`

Do only what that subcommand asks. Baselines are approved only because a
person typed `/testivai approve`: never approve anything else, and never
approve on your own in a later turn.

## status (also when nothing was typed)

Read `visual-report/results.json`. If there is none, say there is no TestivAI
report yet and that the visual tests write it.

Reply with the summary line (changed, passed, new and missing counts), then
one line per `changed` snapshot: its name, `diffPercent`, and what the fields
say, first match wins:

- `captureHealth.unhealthy` set: unhealthy capture, with its `reasons`
- `sizeMismatch`: the page size changed (baseline → current)
- `dom.changed`: the DOM changed (`dom.summary` counts)
- `dom.styleCheck` is `"mismatch"`: a style-only change (`dom.styleChanges`)
- `environment.renderingDelta` not empty: the environment changed since the
  baseline (those fields)
- otherwise: pixels differ while the DOM and styles match

Then the `missingBaselines`. Never call a diff noise or harmless from these
fields alone; the HTML report (`/testivai report`) gives the complete
reading. Do not approve anything.

## report [folder]

If the `/testivai-report` command is available (the TestivAI Claude Code
plugin), tell the person to run `/testivai-report [folder]`. Otherwise give
the path of `<folder>/index.html` (default `visual-report/index.html`), and
show it if you can show files here.

## approve <name...|--all> [--pr]

Never run a bare `npx testivai approve`: with no name it opens an interactive
list. If no name and no `--all` was typed, ask which snapshots to approve and
stop.

**Here, on this machine**, when `--pr` was not typed and this checkout has the
captures (`.testivai/temp/<name>/`, or for `--all` any folder in
`.testivai/temp/`): run `npx testivai approve '<name>'` once per name, each
name single-quoted, or `npx testivai approve --all`. Report what was approved
and any health warning it printed. Do not commit or push unless the person
asks.

**On the pull request**, when `--pr` was typed, or there are no local captures
and the current branch has an open pull request: the approve GitHub Action
(`testivai/testivai-oss/approve@v1`) does the approving. Post one comment on
that pull request whose first line is exactly `/testivai approve <target>`
(`<target>` is the names separated by spaces, or `--all`), with the names on
that line and nothing before it. The action reads only the first line. Use
`gh pr comment <number> --body '/testivai approve <target>'` or your GitHub
comment tool. If you cannot comment there, give the person that line to post
themselves. The action approves only for a commenter with write access to the
repository, and it replies on the pull request with what it approved.

If neither applies, say there is nothing to approve here and why.

## Anything else

Say which subcommands exist: `status`, `report [folder]`,
`approve <name...|--all> [--pr]`.
