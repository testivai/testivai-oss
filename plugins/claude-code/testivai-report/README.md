# testivai-report — the TestivAI visual report inside Claude Code

A Claude Code plugin that shows a TestivAI visual report in the app, instead
of a link or a snippet in the transcript:

- **`/testivai-report [folder]`** opens the full report, screenshots included,
  as a whole page in the side panel. The plugin inlines the report's images
  into one standalone file (`visual-report/report.standalone.html`) and
  shows it with Claude Code's own file viewer. Nothing is uploaded anywhere:
  the page is read from and written to your project.
- **A pane** beside the chat lists every snapshot with its status, diff
  percentage and the reading of the layered analysis (DOM changed, style-only
  change, likely render noise, rendering drift, unhealthy capture, size
  change), changed first. **Open full report** shows the page; **Refresh**
  re-reads `results.json`.
- **After a run**, when Claude runs `testivai witness`, your Playwright tests
  with the TestivAI reporter, or anything that touches `visual-report/`, the
  pane refreshes and a toast says what the run found
  (`TestivAI: 2 changed · 1 passed · 3 total`). Once per run.

The plugin never approves anything. Approving a baseline stays a human
decision: `npx testivai approve <name>`, or the approve tools of
[`@testivai/mcp`](../../../packages/mcp) once you confirm.

## Install

At the prompt of a Claude Code session:

```
/plugin install testivai-report --marketplace testivai/testivai-oss
```

From a shell:

```bash
claude plugin install testivai-report --marketplace testivai/testivai-oss
```

Then run your visual tests as usual. The report is read from
`visual-report/` under the session's working directory (the TestivAI
default); `/testivai-report path/to/report` names another folder.

## Why the page, and not the pane

A Claude Code pane cannot draw screenshots: the desktop app has no raster
image element for plugins, and its vector element is capped at 128 KB, less
than one full-page screenshot. So the pane carries the verdicts, and the
whole report goes through the app's file viewer, where every image shows at
full size.

An image over 4 MB cannot be read by a plugin and keeps its relative path in
the standalone page; the command's reply names it.

## Development

The plugin is a hooks module (`hooks/register.tsx`) with its pure half in
`hooks/report.ts`; its tests run against the Claude Code engine itself:

```bash
claude plugin validate plugins/claude-code/testivai-report
claude plugin test plugins/claude-code/testivai-report
```

`tsconfig.json` points your editor and `tsc --noEmit -p .` at the engine's
types, which Claude Code writes to `.claude-plugin/types/` (git-ignored) when
it loads the plugin.

`tests/report.test.ts` covers the readings, `results.json` parsing, image
inlining and where the report is; `tests/plugin.test.tsx` runs the command,
the pane on the terminal, desktop, VS Code and mobile surfaces, and the
after-run notice, with a fake project beneath. The function-hooks API is
early access; CI pins the Claude Code version the tests ran against.
