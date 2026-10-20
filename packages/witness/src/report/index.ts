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
export {
  commonEnvironment,
  describeCaptureMethod,
  describeEnvironmentChange,
  diffEnvironments,
  environmentChangeGroups,
  environmentChangeLine,
  isRenderingDrift,
  snapshotEnvironmentChange,
} from './environment';
export type { EnvironmentChangeGroup, EnvironmentSnapshotInput } from './environment';
export {
  approveHealthWarning,
  assessHealth,
  BASELINE_HEALTH_PREFIX,
  captureHealthReading,
  healthAllowsTolerances,
  isUnhealthyCapture,
  SAME_FAILURES_NEXT,
  sameHealthFailures,
  snapshotCaptureHealth,
  UNHEALTHY_BASELINE_NEXT,
  UNHEALTHY_CAPTURE_NEXT,
} from './health';
export type { CaptureHealthReading, HealthAssessment, HealthSnapshotInput } from './health';
export { parseHealth } from '../capture/health';
export type { CaptureEnvironment, RenderEnvironment } from '../capture/environment';
export type { CaptureHealth, ResourceFailures, ResourceType } from '../capture/health';
export type {
  ReportData,
  ReportSummary,
  SnapshotResult,
  SnapshotStatus,
  SnapshotCaptureHealth,
  SnapshotDomSignal,
  SnapshotEnvironment,
} from './results';
