/**
 * TestivAI Report — Generator
 *
 * Orchestrator: compareAll → build ReportData → write results.json
 * → render HTML → optionally auto-open browser.
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { compareAll, type CompareOptions, type PassCriteria } from './compare';
import type { ReportData, ReportSummary, SnapshotResult} from './results';
import { renderHtml } from './template';
import { loadLocalConfig } from '../config/local-config';
import { BaselineStore } from '../baselines/store';
import { type CaptureEnvironment, parseEnvironmentVariant, readEnvironment } from '../capture/environment';
import { commonEnvironment } from './environment';

export interface GenerateReportOptions {
  projectRoot: string;
  /** Directory for report output. Default: 'visual-report' */
  reportDir?: string;
  /** Diff threshold (0-1). Default: 0.1 */
  threshold?: number;
  /** Auto-open browser after generating. Default: true */
  autoOpen?: boolean;
  /** SDK version string for the report header */
  version?: string;
  /**
   * Pass criteria overrides. When omitted, values are read from
   * `.testivai/config.json` (maxDiffPercent, maxDiffPixels, noiseAutoPass,
   * noiseMaxDiffPercent) so every adapter honors the project's tolerances
   * without extra wiring.
   */
  passCriteria?: PassCriteria;
}

/**
 * Generate a complete visual regression report.
 *
 * 1. Compare all temp screenshots against baselines
 * 2. Build ReportData with summary
 * 3. Write results.json (machine-readable)
 * 4. Render and write index.html
 * 5. Optionally open in browser
 *
 * @returns The report data
 */
/**
 * results.json schema version. 2.5.0 adds capture provenance: per-snapshot
 * `environment` (what changed between the environment the baseline was
 * captured in and the current capture's: `delta`, `renderingDelta`, both
 * blocks when they differ, and `policy: "strict"` when that policy made the
 * snapshot changed) and the run-level `environment` (the fields every capture
 * of the run agrees on). 2.4.0 added per-snapshot `sizeMismatch`
 * (the baseline's and the candidate's dimensions when they differ; the diff
 * is then on a canvas of max width × max height with every padded pixel
 * counted as changed). 2.3.0 added top-level `missingBaselines[]`
 * and `summary.missing` (baselines that received no capture this run — the
 * coverage-loss signal). 2.2.0 added per-snapshot `regions[]` (clustered
 * diff bounding boxes), `masks[]` (applied masks with their source — the
 * audit trail), and `maskWarnings[]`. All additive.
 */
export const RESULTS_SCHEMA_VERSION = '2.5.0';

/**
 * Write results.json for an already-computed set of snapshot results.
 * Exposed for callers that manage comparison and rendering separately.
 */
export function generateResults(
  results: SnapshotResult[],
  reportDir: string,
  version: string = RESULTS_SCHEMA_VERSION,
): void {
  const data = buildReportData(results, version);
  fs.writeFileSync(path.join(reportDir, 'results.json'), JSON.stringify(data, null, 2));
}

export function generateReport(options: GenerateReportOptions): ReportData {
  const {
    projectRoot,
    reportDir: reportDirRelative = 'visual-report',
    threshold = 0.1,
    autoOpen = true,
    version = RESULTS_SCHEMA_VERSION,
  } = options;

  const reportDir = path.isAbsolute(reportDirRelative)
    ? reportDirRelative
    : path.join(projectRoot, reportDirRelative);

  // Ensure report directory exists
  fs.mkdirSync(reportDir, { recursive: true });

  // 1. Compare all snapshots. Pass criteria default to the project's
  // .testivai/config.json so tolerances follow the config file everywhere.
  const localConfig = loadLocalConfig(projectRoot);
  const passCriteria: PassCriteria = options.passCriteria ?? {
    maxDiffPercent: localConfig.maxDiffPercent,
    maxDiffPixels: localConfig.maxDiffPixels,
    noiseAutoPass: localConfig.noiseAutoPass,
    noiseMaxDiffPercent: localConfig.noiseMaxDiffPercent,
    shiftTolerance: localConfig.shiftTolerance,
  };
  const compareOptions: CompareOptions = {
    projectRoot,
    reportDir,
    threshold,
    passCriteria,
    mask: localConfig.mask,
    diffRegions: localConfig.diffRegions,
    volatileAttributes: localConfig.volatileAttributes,
    environmentPolicy: localConfig.environmentPolicy,
  };
  const snapshots = compareAll(compareOptions);

  // 1.5. Coverage-loss signal: baselines that received no capture this run
  // (a deleted/renamed test silently stops guarding its page). Reported
  // always; gated only via `--fail-on-missing` / config `failOnMissing`,
  // because filtered runs (`--grep`) legitimately skip most baselines.
  // Under environmentPolicy "separate", a baseline keyed for another
  // environment (another browser or platform) is not this run's to capture,
  // so only baselines of an environment this run captured can be missing.
  const store = new BaselineStore(projectRoot);
  const capturedNames = store.listTemp();
  const captured = new Set(capturedNames);
  const variantKey = (v: { browser: string; platform: string }) => `${v.browser}__${v.platform}`;
  const capturedVariants = new Set(
    capturedNames.map(parseEnvironmentVariant).filter((v): v is NonNullable<typeof v> => v !== null).map(variantKey),
  );
  const missingBaselines = store.list().filter((n) => {
    if (captured.has(n)) return false;
    if (localConfig.environmentPolicy !== 'separate') return true;
    const variant = parseEnvironmentVariant(n);
    return variant === null || capturedVariants.has(variantKey(variant));
  });

  // 1.6. Run-level capture provenance: the fields every capture of this run
  // that recorded an environment agrees on.
  const environment = commonEnvironment(
    capturedNames
      .map((n) => readEnvironment(store.readTempMetadata(n)?.environment))
      .filter((e): e is CaptureEnvironment => e !== null),
  );

  // 2-3. Build summary + report data
  const reportData = buildReportData(snapshots, version, missingBaselines, environment);

  // 4. Write results.json
  const resultsPath = path.join(reportDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(reportData, null, 2));

  // 5. Render and write HTML
  const html = renderHtml(reportData);
  const htmlPath = path.join(reportDir, 'index.html');
  fs.writeFileSync(htmlPath, html);

  // 6. Auto-open browser
  if (autoOpen) {
    openInBrowser(htmlPath);
  }

  return reportData;
}

/** Assemble the ReportData envelope for a set of snapshot results. */
function buildReportData(
  snapshots: SnapshotResult[],
  version: string,
  missingBaselines: string[] = [],
  environment: Partial<CaptureEnvironment> | null = null,
): ReportData {
  const summary: ReportSummary = {
    total: snapshots.length,
    passed: snapshots.filter((s) => s.status === 'passed').length,
    changed: snapshots.filter((s) => s.status === 'changed').length,
    newSnapshots: snapshots.filter((s) => s.status === 'new').length,
    missing: missingBaselines.length,
  };
  return {
    version,
    timestamp: new Date().toISOString(),
    summary,
    snapshots,
    missingBaselines,
    ...(environment ? { environment } : {}),
  };
}

/**
 * Build a single-file, shareable copy of the report: every report-relative
 * image reference (`src` and the region-chip `data-diff` attributes) is
 * inlined as a base64 data URI, so the resulting HTML can be dropped into
 * Slack, an issue, or an email with nothing else attached.
 *
 * Reads `<reportDir>/index.html`, writes `<reportDir>/share.html`, and
 * returns the absolute path of the share file.
 */
export function generateShareFile(reportDir: string): string {
  const indexPath = path.join(reportDir, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf-8');

  const inlined = html.replace(
    /(src|data-diff)="(images\/[^"]+)"/g,
    (match, attr: string, rel: string) => {
      try {
        const abs = path.join(reportDir, rel);
        const data = fs.readFileSync(abs);
        return `${attr}="data:image/png;base64,${data.toString('base64')}"`;
      } catch {
        return match; // missing image: leave the reference as-is
      }
    },
  );

  const sharePath = path.join(reportDir, 'share.html');
  fs.writeFileSync(sharePath, inlined);
  return sharePath;
}

/**
 * Storage-agnostic share upload: run the user's configured shell command
 * (from `.testivai/config.json` `shareUploadCommand`) with `{file}` replaced
 * by the share file's path. The last non-empty stdout line is returned as
 * the shared URL — so `aws s3 cp … && echo https://…`, `gsutil`, `rclone`,
 * or a plain `curl` all work without TestivAI shipping any cloud SDK.
 *
 * Returns the URL string, or null when the command produced no output.
 * Throws on a non-zero exit (caller decides how loud to be).
 */
export function uploadShareFile(commandTemplate: string, sharePath: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execSync } = require('child_process') as typeof import('child_process');
  const command = commandTemplate.split('{file}').join(JSON.stringify(sharePath));
  const stdout = execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = stdout.split('\n').map((l: string) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

/**
 * Open a file in the default browser.
 * Best-effort — does not throw on failure.
 */
function openInBrowser(filePath: string): void {
  const url = `file://${filePath}`;
  const platform = process.platform;

  let cmd: string;
  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      // Silently ignore — CI environments won't have a browser
    }
  });
}
