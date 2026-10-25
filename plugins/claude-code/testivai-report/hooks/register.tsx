// testivai-report: the TestivAI visual report inside Claude Code.
//
// - /testivai-report [folder]: inlines the report's images into one standalone
//   page and shows it whole in the side panel (SendUserFile, display render).
//   Nothing leaves the machine.
// - A docked pane lists every snapshot with its reading, and a button opens
//   the whole report.
// - After a Bash command that ran TestivAI, the pane refreshes and a toast
//   says what the run found.
//
// A pane cannot draw the screenshots (no raster image element on the desktop
// surface, and an Svg is capped at 128 KB), which is why the whole page goes
// through SendUserFile.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReportState } from '../types'
import { DEFAULT_REPORT_DIR, inlineImages, isReportCommand, parseResults, resolveReportDir, summaryLine } from './report'

const PANE = 'testivai-report'
const COMMAND = 'testivai-report'
const STANDALONE = 'report.standalone.html'

// The report the pane shows. The shape tag declines what an earlier version stored.
const report = atom({ plugin: 'testivai-report', key: 'report' } as const, null, { shape: 'report-1' })

/** results.json in `dir`, read into the pane's state; null when there is none. */
async function loadReport($: EngineInterface, dir: string): Promise<ReportState | null> {
  const results = `${dir}/results.json`
  if (!(await $.fs.exists(results))) return null
  const stat = await $.fs.stat(results)
  const text = await $.fs.read(results)
  return parseResults(text, dir, stat.mtimeMs)
}

/** The report folder for the session's cwd. */
async function defaultDir($: EngineInterface): Promise<string> {
  return resolveReportDir(await $.session.cwd(), '')
}

/**
 * Builds `<dir>/report.standalone.html` from the report's index.html with every
 * image inlined, and shows it whole in the side panel. Returns what to tell.
 */
async function openReport($: EngineInterface, state: ReportState): Promise<string> {
  const index = `${state.dir}/index.html`
  if (!(await $.fs.exists(index))) return `${state.dir} has results.json but no index.html: run the TestivAI reporter again to render the report.`
  const html = await $.fs.read(index)
  const { html: standalone, inlined, skipped } = await inlineImages(html, async rel => {
    try {
      return (await $.fs.read(`${state.dir}/${rel}`, { as: 'bytes' })).base64
    } catch {
      return undefined
    }
  })
  const out = `${state.dir}/${STANDALONE}`
  await $.fs.write(out, standalone)
  const line = summaryLine(state.summary)
  const sent = await $.tool.call({ tool: 'SendUserFile', files: [out], display: 'render', status: 'normal', caption: `TestivAI visual report: ${line}` })
  const left = skipped.length > 0 ? ` ${skipped.length} image${skipped.length === 1 ? '' : 's'} could not be read (over 4 MB, or missing) and keep${skipped.length === 1 ? 's' : ''} a path: ${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', …' : ''}.` : ''
  if (sent.deny !== undefined || sent.isError) {
    return `TestivAI report (${line}) written to ${out}, ${inlined} images inlined, but it could not be shown here: ${sent.deny ?? sent.text ?? 'the file was not sent'}. Open the file instead.${left}`
  }
  return `TestivAI report: ${line}. Shown whole in the side panel (${out}, ${inlined} images inlined).${left}`
}

function noReport(dir: string): string {
  return `No TestivAI report at ${dir}: run your visual tests first, or name the folder: /testivai-report <folder>.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the TestivAI visual report whole in the side panel; the pane lists each snapshot. Optional: the report folder (default visual-report).',
      argumentHint: '[folder]',
    })
    const state = await loadReport($, resolveReportDir(e.cwd, ''))
    if (state) {
      await update($, report, () => state)
      void $.ui.open({ id: PANE, title: 'TestivAI report' })
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const dir = resolveReportDir(await $.session.cwd(), e.args)
    const state = await loadReport($, dir)
    if (!state) return { text: noReport(dir) }
    await update($, report, () => state)
    await $.ui.open({ id: PANE, title: 'TestivAI report' })
    if (state.error) return { text: `${dir}/results.json could not be read: ${state.error}.` }
    return { text: await openReport($, state) }
  }).catch(($, e) => ({ text: `${$.plugin.name}: the report could not be shown (${e.command}): see the debug log.` }))

  // After a command that ran TestivAI (or touched its report), look at
  // results.json: a new run refreshes the pane and says what it found, once.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!isReportCommand(e.command)) return ran
    const before = await read($, report)
    const state = await loadReport($, before?.dir ?? (await defaultDir($)))
    if (!state || (before && before.mtimeMs === state.mtimeMs && before.dir === state.dir)) return ran
    await update($, report, () => state)
    if (!state.error) $.ui.toast(`TestivAI: ${summaryLine(state.summary)}. /${COMMAND} opens the full report.`)
    void $.ui.open({ id: PANE, title: 'TestivAI report' })
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await read($, report)
    const dir = state?.dir ?? (await defaultDir($))

    if (!state || state.error) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>TestivAI report</Text>
          <Text dimColor>{state?.error ? `${dir}/results.json could not be read: ${state.error}.` : `No TestivAI report at ${dir} yet. Run your visual tests, or /${COMMAND} <folder>.`}</Text>
          <Button key="refresh" label="Refresh" onPress={async () => update($, report, () => null).then(() => loadReport($, dir)).then(next => update($, report, () => next))} />
        </Box>
      )
    }

    const color = { changed: 'red', new: 'yellow', passed: 'green' } as const
    const mark = { changed: '✗', new: '+', passed: '✓' } as const
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>TestivAI report · {summaryLine(state.summary)}</Text>
          <Text dimColor>{state.dir}</Text>
        </Box>
        <Box gap={1}>
          <Button key="open" label="Open full report" hotkey="o" onPress={() => openReport($, state).then(text => $.ui.toast(text.slice(0, 200)))} />
          <Button key="refresh" label="Refresh" hotkey="r" onPress={async () => update($, report, () => null).then(() => loadReport($, state.dir)).then(next => update($, report, () => next))} />
        </Box>
        <Box flexDirection="column">
          {state.rows.map(row => (
            <Box key={`row-${row.name}`} flexDirection="column">
              <Text>
                <Text color={color[row.status]}>{mark[row.status]} </Text>
                <Text bold>{row.name}</Text>
                {row.status === 'changed' ? <Text dimColor> {row.diffPercent}% different</Text> : null}
              </Text>
              <Text dimColor>  {row.reading}</Text>
            </Box>
          ))}
          {state.missingBaselines.length > 0 ? (
            <Text color="yellow">missing: {state.missingBaselines.join(', ')} (baselines that received no capture)</Text>
          ) : null}
        </Box>
      </Box>
    )
  })
}
