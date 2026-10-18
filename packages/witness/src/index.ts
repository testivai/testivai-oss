/**
 * TestivAI Witness SDK
 * Framework-agnostic visual regression testing CLI
 */

// Export types
export * from './types';

// Export browser modules
export { BrowserClient } from './browser/client';
export { BrowserCapture } from './browser/capture';
export { BrowserBinding } from './browser/binding';
export { BrowserDiscovery, BrowserDiscoveryError } from './browser/discovery';

// Export utilities
export { logger, createLogger } from './utils/logger';
export { toSafeFilename, generateUniqueFilename, extractNameFromUrl, sanitizeTestName, isSafeFilename } from './utils/file-naming';
export { ProcessManager, spawnProcess, setupSignalHandlers, commandExists } from './utils/process';
export { FrameworkDetector } from './utils/framework-detect';

// Export diff engine
export * from './diff';

// Export baselines
// Element-map capture — the page-side collector shared by every adapter.
export { collectElementMap, buildElementMapExpression, DEFAULT_MAX_ELEMENTS } from './capture/element-map';
export type { CollectedElement } from './capture/element-map';

// Shard participation — the env-var contract every adapter honours.
export { parseShardEnv, resolveCaptureOnly, writeShardManifest, SHARD_MANIFEST } from './capture/shard';
export type { ShardInfo, ShardManifest } from './capture/shard';

// Page-settled probe — shared by every adapter.
export {
  settleProbe,
  buildSettleProbeExpression,
  SETTLE_STOP_EXPRESSION,
  SETTLE_STATE_KEY,
  DEFAULT_QUIET_MS,
  DEFAULT_SETTLE_TIMEOUT_MS,
} from './capture/settle';
export type { SettleState } from './capture/settle';

// Stable full-page capture (fresh frame + capture until two in a row match) —
// shared by every adapter that captures through CDP captureBeyondViewport.
export {
  FRESH_FRAME_EXPRESSION,
  FRESH_FRAME_TIMEOUT_MS,
  MAX_STABLE_CAPTURES,
  settleFreshFrame,
  captureUntilStable,
} from './capture/stable-capture';
export type { CaptureLog, CaptureUntilStableOptions } from './capture/stable-capture';

export { BaselineStore } from './baselines';
export type { BaselineMetadata } from './baselines';

// Export local config
export {
  loadLocalConfig,
  createDefaultConfig,
  localConfigExists,
  getConfigPath,
  getDefaultConfig,
} from './config';
export type { LocalConfig } from './config';

// Export report generator
export { generateReport, compareAll, renderHtml } from './report';
export type { GenerateReportOptions, CompareOptions, ReportData, ReportSummary, SnapshotResult, SnapshotStatus } from './report';

// Export commands (for programmatic use)
export { initCommand } from './commands/init';
export { runCommand } from './commands/run';
export { witnessCommand } from './commands/capture';
export { approveCommand } from './commands/approve';

// Version
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const VERSION = require('../package.json').version;
