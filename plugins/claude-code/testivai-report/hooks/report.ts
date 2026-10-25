// The pure half of the plugin: reading results.json into pane rows, the
// one-line reading per snapshot, inlining a report's images into one
// standalone page, and where the report is. No `$` here, so every function
// is tested on its own (tests/report.test.ts).

import type { ReportRow, ReportState } from '../types'

export const DEFAULT_REPORT_DIR = 'visual-report'

/** A snapshot of results.json, the fields the reading uses (witness schema 2.x). */
export type ReportSnapshot = {
  name: string
  status: 'changed' | 'new' | 'passed'
  diffPercent?: number
  autoPassed?: string
  dom?: {
    changed?: boolean
    noiseHint?: boolean
    summary?: { added: number; removed: number; attributeChanges: number; textChanges: number } | null
    styleCheck?: 'match' | 'mismatch' | 'unavailable'
    styleChanges?: { count: number; elements?: string[] }
  }
  sizeMismatch?: { baseline: { width: number; height: number }; candidate: { width: number; height: number } }
  environment?: { delta?: string[]; renderingDelta?: string[] }
  captureHealth?: { unhealthy?: 'candidate' | 'baseline' | 'both' | null; reasons?: string[]; warnings?: string[] }
  [extra: string]: unknown
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * What the layered analysis says about one snapshot, in one line: the same
 * precedence as the report and the PR comment (unhealthy capture first, then
 * a size change, a DOM change, rendering drift, a style-only change, and only
 * then "likely render noise", never when styles were not compared).
 */
export function readingFor(s: ReportSnapshot): string {
  if (s.status === 'new') return 'new snapshot: no baseline yet'
  if (s.status === 'passed') return s.autoPassed ? `passed (auto-passed: ${s.autoPassed})` : 'passed'

  const health = s.captureHealth
  if (health?.unhealthy) {
    const why = health.reasons?.[0] ?? 'what failed to load is in the report'
    return `unhealthy capture (${health.unhealthy}): ${why}`
  }
  const size = s.sizeMismatch
  if (size) return `size changed: ${size.baseline.width}×${size.baseline.height} → ${size.candidate.width}×${size.candidate.height}`

  const dom = s.dom
  if (dom?.changed) {
    const d = dom.summary
    return d ? `DOM changed: ${d.added} added, ${d.removed} removed, ${d.attributeChanges} attribute, ${d.textChanges} text` : 'DOM changed'
  }
  if (dom?.styleCheck === 'match') {
    const drift = s.environment?.renderingDelta ?? []
    if (drift.length > 0) return `rendering drift: ${drift.join(', ')} changed, the page did not`
    if (dom.noiseHint) return 'likely render noise: DOM and styles match, diff small and scattered'
    return 'DOM and styles unchanged, but the diff is concentrated or large: compare the images'
  }
  if (dom?.styleCheck === 'mismatch') return `style-only change: ${plural(dom.styleChanges?.count ?? 0, 'element')}`
  return 'DOM unchanged, styles not compared: compare the images'
}

const ORDER: Record<ReportSnapshot['status'], number> = { changed: 0, new: 1, passed: 2 }

/** "2 changed · 1 passed · 1 missing · 3 total", leaving out what is zero (passed and total always shown). */
export function summaryLine(s: ReportState['summary']): string {
  const parts: string[] = []
  if (s.changed) parts.push(`${s.changed} changed`)
  if (s.newSnapshots) parts.push(`${s.newSnapshots} new`)
  parts.push(`${s.passed} passed`)
  if (s.missing) parts.push(`${s.missing} missing`)
  parts.push(`${s.total} total`)
  return parts.join(' · ')
}

const EMPTY_SUMMARY = { total: 0, passed: 0, changed: 0, newSnapshots: 0, missing: 0 }

/** results.json's text → what the pane shows; `error` set (and no rows) when it is not a report. */
export function parseResults(text: string, dir: string, mtimeMs: number): ReportState {
  const base: ReportState = { dir, mtimeMs, summary: EMPTY_SUMMARY, missingBaselines: [], rows: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ...base, error: 'results.json is not valid JSON' }
  }
  const data = raw as { summary?: Partial<ReportState['summary']>; snapshots?: ReportSnapshot[]; missingBaselines?: string[] }
  if (!data || typeof data !== 'object' || !Array.isArray(data.snapshots) || typeof data.summary !== 'object' || data.summary === null) {
    return { ...base, error: 'not a TestivAI results.json: it has no summary and snapshots' }
  }
  const rows: ReportRow[] = data.snapshots
    .filter(s => s && typeof s.name === 'string' && s.status in ORDER)
    .sort((a, b) => ORDER[a.status] - ORDER[b.status])
    .map(s => ({
      name: s.name,
      status: s.status,
      diffPercent: Math.round((s.diffPercent ?? 0) * 100) / 100,
      reading: readingFor(s),
    }))
  const summary = { ...EMPTY_SUMMARY, ...Object.fromEntries(Object.entries(data.summary).filter(([, v]) => typeof v === 'number')) } as ReportState['summary']
  return { ...base, summary, missingBaselines: Array.isArray(data.missingBaselines) ? data.missingBaselines.filter(n => typeof n === 'string') : [], rows }
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', '#39': "'", '#039': "'", lt: '<', gt: '>' }

/** An attribute value as written in the HTML, unescaped once: `&amp;lt;` is `&lt;`, never `<`. */
const unescapeAttr = (v: string) => v.replace(/&(amp|quot|#39|#039|lt|gt);/g, (whole, name: string) => ENTITIES[name] ?? whole)

/**
 * Every `<img src="…">` with a relative path becomes a data URI, read through
 * `read` (base64 bytes, or undefined for an image that cannot be read, which
 * keeps its path and is listed in `skipped`). Data, remote and empty sources
 * are left as they are.
 */
export async function inlineImages(html: string, read: (relativePath: string) => Promise<string | undefined>): Promise<{ html: string; inlined: number; skipped: string[] }> {
  const pattern = /(<img\b[^>]*?\bsrc=")([^"]*)(")/g
  const matches = [...html.matchAll(pattern)]
  const skipped: string[] = []
  let inlined = 0
  const replacements = new Map<number, string>()
  for (const m of matches) {
    const src = m[2] ?? ''
    if (src === '' || /^(data:|https?:|\/\/)/i.test(src)) continue
    const rel = unescapeAttr(src)
    const base64 = await read(rel)
    if (base64 === undefined) {
      skipped.push(rel)
      continue
    }
    const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
    replacements.set(m.index ?? -1, `${m[1]}data:${MIME[ext] ?? 'application/octet-stream'};base64,${base64}${m[3]}`)
    inlined += 1
  }
  let out = ''
  let last = 0
  for (const m of matches) {
    const at = m.index ?? -1
    const replacement = replacements.get(at)
    if (replacement === undefined) continue
    out += html.slice(last, at) + replacement
    last = at + m[0].length
  }
  out += html.slice(last)
  return { html: out, inlined, skipped }
}

/** The report folder: the command's argument (a folder, or its results.json), else visual-report under the cwd. */
export function resolveReportDir(cwd: string, args: string, fallback = DEFAULT_REPORT_DIR): string {
  let given = args.trim()
  if (given.endsWith('/results.json')) given = given.slice(0, -'/results.json'.length)
  const path = given === '' ? fallback : given
  const absolute = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`
  return absolute.length > 1 ? absolute.replace(/\/+$/, '') : absolute
}

/** A Bash command that ran TestivAI or read its report: worth a look at results.json afterwards. */
export function isReportCommand(command: string): boolean {
  return /\btestivai\s+(witness|approve|compare)\b|@testivai\/witness|\bvisual-report\b/.test(command)
}
