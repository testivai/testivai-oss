// The plugin against the engine: the /testivai-report command, the pane on
// every surface, and the notice after a Bash command that ran TestivAI.
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/proj'
const DIR = `${CWD}/visual-report`

const RESULTS = {
  version: '2.8.0',
  timestamp: '2026-10-25T10:00:00.000Z',
  summary: { total: 3, passed: 1, changed: 2, newSnapshots: 0, missing: 0 },
  snapshots: [
    { name: 'home', status: 'changed', diffPercent: 0.1, dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0, textChanges: 1 }, styleCheck: 'unavailable' }, baselinePath: 'images/home/baseline.png', currentPath: 'images/home/current.png', diffPath: 'images/home/diff.png' },
    { name: 'pricing_html', status: 'changed', diffPercent: 0.07, dom: { changed: false, noiseHint: false, summary: null, styleCheck: 'mismatch', styleChanges: { count: 1, elements: ['.price'] } } },
    { name: 'about_html', status: 'passed', diffPercent: 0 },
  ],
}

const INDEX = '<!DOCTYPE html><html><body><img src="images/home/baseline.png" alt="Baseline"><img src="images/home/current.png" alt="Current"></body></html>'

const PANE = {
  plugin: 'testivai-report',
  component: 'Pane',
  requestId: 'testivai-report',
  props: { title: 'TestivAI report', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const COMMAND = { command: 'testivai-report', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

/**
 * A project on disk: results.json, index.html and two PNGs under DIR while
 * `world.hasReport` is true (it can change after the hooks are registered,
 * as a run writes the report), and what the plugin did.
 */
function fakeProject(on: On, { hasReport = true, mtimeMs = 1000 } = {}) {
  const world = {
    hasReport,
    mtimeMs,
    written: [] as Array<{ path: string; text: string }>,
    sent: [] as Array<Record<string, unknown>>,
    toasts: [] as string[],
    opened: [] as string[],
  }
  const files = (): Record<string, string> => (world.hasReport ? { [`${DIR}/results.json`]: JSON.stringify(RESULTS), [`${DIR}/index.html`]: INDEX } : {})
  const bytes = (): Record<string, string> => (world.hasReport ? { [`${DIR}/images/home/baseline.png`]: 'QkFTRQ==', [`${DIR}/images/home/current.png`]: 'Q1VSUg==' } : {})

  on('session.cwd', () => ({ value: CWD }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'testivai-report' } }))
  on('ui.open', (_, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: e.path in files() || e.path in bytes() }))
  on('fs.stat', (_, e) => {
    if (!(e.path in files()) && !(e.path in bytes())) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: 1, mtimeMs: world.mtimeMs, isLink: false } }
  })
  on('fs.read', (_, e) => {
    if (e.as === 'bytes') {
      const base64 = bytes()[e.path]
      if (base64 === undefined) throw new Error(`ENOENT: ${e.path}`)
      return { value: { base64 } }
    }
    const text = files()[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    world.written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('tool.call', { tool: 'SendUserFile' }, (_, e) => {
    world.sent.push({ files: e.files, display: e.display, status: e.status, caption: e.caption })
    return { result: { attachments: [] } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: {} }))

  return world
}

test('/testivai-report writes one standalone page with the images inlined, and shows it whole', async ($, on) => {
  const world = fakeProject(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ran = await $.command.run(COMMAND)

  expect(world.written).toHaveLength(1)
  const page = world.written[0]!
  expect(page.path).toBe(`${DIR}/report.standalone.html`)
  expect(page.text).toContain('src="data:image/png;base64,QkFTRQ=="')
  expect(page.text).toContain('src="data:image/png;base64,Q1VSUg=="')
  expect(page.text).not.toMatch(/src="images\//)
  expect(world.sent).toEqual([{ files: [page.path], display: 'render', status: 'normal', caption: expect.stringContaining('2 changed') }])
  expect(ran.text).toContain('2 changed · 1 passed · 3 total')
  expect(ran.text).toContain('2 images inlined')
  expect(world.opened).toContain('testivai-report')
})

test('/testivai-report says so when there is no report, and sends nothing', async ($, on) => {
  const world = fakeProject(on, { hasReport: false })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ran = await $.command.run(COMMAND)

  expect(ran.text).toMatch(/No TestivAI report at \/proj\/visual-report/)
  expect(ran.text).toMatch(/testivai-report <folder>/)
  expect(world.sent).toEqual([])
  expect(world.written).toEqual([])
})

test('the pane lists every snapshot with its reading, on every surface, and its button opens the whole report', async ($, on) => {
  const world = fakeProject(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /2 changed/ }))?.text).toContain('2 changed · 1 passed · 3 total')
    expect(await ui.find({ type: 'Text', text: /home/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /DOM changed/ }))?.text).toContain('DOM changed: 1 added, 0 removed, 0 attribute, 1 text')
    expect((await ui.find({ type: 'Text', text: /style-only/ }))?.text).toContain('style-only change: 1 element')
    expect(await ui.find({ type: 'Text', text: /about_html/ })).toBeDefined()

    const before = world.sent.length
    await ui.press({ key: 'open' })
    expect(world.sent).toHaveLength(before + 1)
    expect(world.sent[before]?.display).toBe('render')
    await ui.unmount()
  }
})

test('the pane says when no report has been found yet', async ($, on) => {
  fakeProject(on, { hasReport: false })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /No TestivAI report/ }))?.text).toContain('/proj/visual-report')
  await ui.unmount()
})

test('a Bash command that ran TestivAI refreshes the pane and toasts once; an unrelated command does nothing', async ($, on) => {
  const world = fakeProject(on, { hasReport: false })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  expect(world.opened).toEqual([])

  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(world.toasts).toEqual([])

  // The run writes the report.
  world.hasReport = true
  await $.tool.call({ tool: 'Bash', command: 'npx testivai witness http://localhost:3000' })

  expect(world.toasts).toEqual([expect.stringContaining('2 changed · 1 passed · 3 total')])
  expect(world.opened).toEqual(['testivai-report'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /pricing_html/ })).toBeDefined()
  await ui.unmount()

  // The same report again: no second toast. A new run (a newer results.json): one more.
  await $.tool.call({ tool: 'Bash', command: 'npx testivai witness http://localhost:3000' })
  expect(world.toasts).toHaveLength(1)
  world.mtimeMs = 2000
  await $.tool.call({ tool: 'Bash', command: 'npx testivai witness http://localhost:3000' })
  expect(world.toasts).toHaveLength(2)

  // An unrelated command never reads the report, even when it changed.
  world.mtimeMs = 3000
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(world.toasts).toHaveLength(2)
})

test('a value an earlier version stored is declined', async ($, on) => {
  fakeProject(on, { hasReport: false })
  on('state.get', () => ({ value: { value: { rows: 'old' }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /No TestivAI report/ })).toBeDefined()
  await ui.unmount()
})
