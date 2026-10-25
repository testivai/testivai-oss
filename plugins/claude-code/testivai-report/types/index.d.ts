/** One snapshot of a report, as the pane lists it. */
export type ReportRow = {
  name: string
  status: 'changed' | 'new' | 'passed'
  /** Percentage of pixels that differ; 0 for a new snapshot. */
  diffPercent: number
  /** The reading in words: what the layered analysis says about the diff. */
  reading: string
}

/** The report the pane shows: where it is and what it holds. */
export type ReportState = {
  /** The report folder, absolute. */
  dir: string
  /** results.json's mtime when read, to tell a new run from the same one. */
  mtimeMs: number
  summary: { total: number; passed: number; changed: number; newSnapshots: number; missing: number }
  missingBaselines: string[]
  rows: ReportRow[]
  /** Why the report could not be read, with no rows then. */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'testivai-report': { report: Shaped<ReportState | null> }
  }
}
