/**
 * TestivAI Report Generator
 */

export { generateReport } from './generator';
export type { GenerateReportOptions } from './generator';
export { compareAll } from './compare';
export type { CompareOptions, PassCriteria } from './compare';
export { renderHtml, snapshotAnchorId } from './template';
export {
  diffShape,
  describeRegions,
  NOISE_MAX_DIFF_PERCENT,
  CONCENTRATED_MAX_PAGE_SHARE,
  STYLE_CHECK_DOES_NOT_COVER,
} from './diff-shape';
export type { DiffShape, DiffShapeBox, DiffShapeInput } from './diff-shape';
export { describeSizeChange, explainHeightChange, formatSizeMismatch, formatSizes, sizeMismatchKind } from './size-mismatch';
export type { Dimensions, HeightChangeContext, SizeMismatchInfo } from './size-mismatch';
export type {
  ReportData,
  ReportSummary,
  SnapshotResult,
  SnapshotStatus,
  SnapshotDomSignal,
} from './results';
