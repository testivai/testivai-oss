// The pure parts: the reading each snapshot gets, results.json → pane rows,
// inlining a report's images into one standalone page, and where the report is.
import { describe, expect, test } from 'claude-code/testing'

import { inlineImages, isReportCommand, parseResults, readingFor, resolveReportDir, summaryLine, type ReportSnapshot } from '../hooks/report'

const snapshot = (over: Partial<ReportSnapshot> = {}): ReportSnapshot => ({
  name: 'home',
  status: 'changed',
  diffPercent: 1.5,
  dom: { changed: false, noiseHint: false, summary: null, styleCheck: 'match' },
  ...over,
})

describe('readingFor: the layered analysis in one line', () => {
  test('a new snapshot has no baseline', async () => {
    expect(readingFor(snapshot({ status: 'new', diffPercent: 0 }))).toBe('new snapshot: no baseline yet')
  })

  test('a passed snapshot names the criterion that auto-passed it', async () => {
    expect(readingFor(snapshot({ status: 'passed' }))).toBe('passed')
    expect(readingFor(snapshot({ status: 'passed', autoPassed: 'noise' }))).toBe('passed (auto-passed: noise)')
  })

  test('an unhealthy capture comes first and is never worded as noise', async () => {
    const reading = readingFor(
      snapshot({
        dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' },
        captureHealth: { unhealthy: 'candidate', reasons: ["web font 'Fancy' failed to load, so the page rendered with a fallback font"], warnings: [] },
      }),
    )
    expect(reading).toBe("unhealthy capture (candidate): web font 'Fancy' failed to load, so the page rendered with a fallback font")
    expect(reading).not.toMatch(/noise/)
  })

  test('a size change says both sizes', async () => {
    expect(readingFor(snapshot({ sizeMismatch: { baseline: { width: 1280, height: 2348 }, candidate: { width: 1280, height: 2538 } } }))).toBe(
      'size changed: 1280×2348 → 1280×2538',
    )
  })

  test('a DOM change says what changed', async () => {
    expect(
      readingFor(snapshot({ dom: { changed: true, noiseHint: false, summary: { added: 4, removed: 0, attributeChanges: 1, textChanges: 2 }, styleCheck: 'unavailable' } })),
    ).toBe('DOM changed: 4 added, 0 removed, 1 attribute, 2 text')
  })

  test('an identical DOM with matching styles reads by the environment, then the diff shape', async () => {
    const match = { changed: false, noiseHint: false, summary: null, styleCheck: 'match' } as const
    expect(readingFor(snapshot({ dom: match, environment: { delta: ['browser.version'], renderingDelta: ['browser.version'] } }))).toBe(
      'rendering drift: browser.version changed, the page did not',
    )
    expect(readingFor(snapshot({ dom: { ...match, noiseHint: true } }))).toBe('likely render noise: DOM and styles match, diff small and scattered')
    expect(readingFor(snapshot({ dom: match }))).toBe('DOM and styles unchanged, but the diff is concentrated or large: compare the images')
  })

  test('a style-only change is real, and uncompared styles leave a stylesheet change open', async () => {
    expect(readingFor(snapshot({ dom: { changed: false, noiseHint: false, summary: null, styleCheck: 'mismatch', styleChanges: { count: 2, elements: ['.a', '.b'] } } }))).toBe(
      'style-only change: 2 elements',
    )
    expect(readingFor(snapshot({ dom: { changed: false, noiseHint: false, summary: null, styleCheck: 'unavailable' } }))).toBe(
      'DOM unchanged, styles not compared: compare the images',
    )
    expect(readingFor(snapshot({ dom: undefined }))).toBe('DOM unchanged, styles not compared: compare the images')
  })
})

const RESULTS = {
  version: '2.8.0',
  timestamp: '2026-10-25T10:00:00.000Z',
  summary: { total: 3, passed: 1, changed: 2, newSnapshots: 0, missing: 1 },
  missingBaselines: ['pricing'],
  snapshots: [
    snapshot({ name: 'home', diffPercent: 0.10458984375, dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0, textChanges: 1 }, styleCheck: 'unavailable' } }),
    snapshot({ name: 'pricing_html', diffPercent: 0.0732421875, dom: { changed: false, noiseHint: false, summary: null, styleCheck: 'mismatch', styleChanges: { count: 1, elements: ['.price'] } } }),
    snapshot({ name: 'about_html', status: 'passed', diffPercent: 0 }),
  ],
}

describe('parseResults', () => {
  test('turns results.json into the pane rows, changed first, with rounded percentages', async () => {
    const state = parseResults(JSON.stringify(RESULTS), '/proj/visual-report', 1000)

    expect(state.error).toBeUndefined()
    expect(state.dir).toBe('/proj/visual-report')
    expect(state.mtimeMs).toBe(1000)
    expect(state.summary).toEqual(RESULTS.summary)
    expect(state.missingBaselines).toEqual(['pricing'])
    expect(state.rows.map(r => [r.name, r.status, r.diffPercent])).toEqual([
      ['home', 'changed', 0.1],
      ['pricing_html', 'changed', 0.07],
      ['about_html', 'passed', 0],
    ])
    expect(state.rows[0]?.reading).toBe('DOM changed: 1 added, 0 removed, 0 attribute, 1 text')
    expect(state.rows[1]?.reading).toBe('style-only change: 1 element')
  })

  test('orders the rows changed, new, passed whatever order the report lists them in', async () => {
    const shuffled = { ...RESULTS, snapshots: [snapshot({ name: 'p', status: 'passed' }), snapshot({ name: 'n', status: 'new' }), snapshot({ name: 'c' }), snapshot({ name: 'p2', status: 'passed' })] }

    expect(parseResults(JSON.stringify(shuffled), '/d', 1).rows.map(r => r.name)).toEqual(['c', 'n', 'p', 'p2'])
  })

  test('a results.json that is not a report gives an error and no rows', async () => {
    expect(parseResults('not json', '/d', 1).error).toMatch(/not valid JSON/)
    expect(parseResults('{"hello":1}', '/d', 1).error).toMatch(/not a TestivAI results\.json/)
    expect(parseResults('{"hello":1}', '/d', 1).rows).toEqual([])
  })

  test('summaryLine reads like the CLI', async () => {
    expect(summaryLine(RESULTS.summary)).toBe('2 changed · 1 passed · 1 missing · 3 total')
    expect(summaryLine({ total: 2, passed: 0, changed: 0, newSnapshots: 2, missing: 0 })).toBe('2 new · 0 passed · 2 total')
  })
})

describe('inlineImages', () => {
  const html = [
    '<img src="images/home/baseline.png" alt="Baseline">',
    '<img src="images/home/diff.png" alt="Diff heatmap">',
    '<img id="zoomImg" src="" alt="Zoomed">',
    '<img src="data:image/png;base64,AAAA" alt="already">',
    '<img src="https://example.com/x.png" alt="remote">',
    '<img src="images/a&amp;b/current.jpg" alt="escaped">',
  ].join('\n')

  test('replaces each relative image with a data URI, leaving data, remote and empty sources alone', async () => {
    const asked: string[] = []
    const out = await inlineImages(html, async rel => {
      asked.push(rel)
      return rel.endsWith('.png') ? 'UE5H' : 'SlBH'
    })

    expect(asked).toEqual(['images/home/baseline.png', 'images/home/diff.png', 'images/a&b/current.jpg'])
    expect(out.inlined).toBe(3)
    expect(out.skipped).toEqual([])
    expect(out.html).toContain('<img src="data:image/png;base64,UE5H" alt="Baseline">')
    expect(out.html).toContain('<img src="data:image/jpeg;base64,SlBH" alt="escaped">')
    expect(out.html).toContain('<img src="data:image/png;base64,AAAA" alt="already">')
    expect(out.html).toContain('<img src="https://example.com/x.png" alt="remote">')
    expect(out.html).toContain('<img id="zoomImg" src="" alt="Zoomed">')
    expect(out.html).not.toMatch(/src="images\//)
  })

  test('keeps the path of an image it cannot read, and names it', async () => {
    const out = await inlineImages(html, async rel => (rel.includes('diff') ? undefined : 'UE5H'))

    expect(out.inlined).toBe(2)
    expect(out.skipped).toEqual(['images/home/diff.png'])
    expect(out.html).toContain('<img src="images/home/diff.png" alt="Diff heatmap">')
  })
})

describe('where the report is', () => {
  test('resolveReportDir: the default folder under the cwd, or the folder the command names', async () => {
    expect(resolveReportDir('/proj', '')).toBe('/proj/visual-report')
    expect(resolveReportDir('/proj', '  ')).toBe('/proj/visual-report')
    expect(resolveReportDir('/proj', 'out/report')).toBe('/proj/out/report')
    expect(resolveReportDir('/proj', '/abs/report/')).toBe('/abs/report')
    expect(resolveReportDir('/proj', 'visual-report/results.json')).toBe('/proj/visual-report')
  })

  test('isReportCommand: a Bash command that runs TestivAI or touches the report', async () => {
    expect(isReportCommand('npx --yes --package @testivai/witness@latest testivai witness http://localhost:3000')).toBe(true)
    expect(isReportCommand('npx playwright test --reporter=@testivai/witness-playwright')).toBe(true)
    expect(isReportCommand('cat visual-report/results.json')).toBe(true)
    expect(isReportCommand('ls -la')).toBe(false)
    expect(isReportCommand('git commit -m "testivai docs"')).toBe(false)
  })
})
