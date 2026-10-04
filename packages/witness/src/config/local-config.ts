/**
 * TestivAI Local Configuration
 *
 * Reads/writes `.testivai/config.json`. Everything runs locally, so this
 * file is optional — absent, every field falls back to its default.
 */

import * as fs from 'fs';
import * as path from 'path';
import { validateLocalConfig } from './validate-config';

export interface LocalConfig {
  /** Pixel diff threshold (0-1). Default: 0.1 */
  threshold: number;
  /** Auto-open HTML report in browser after test run. Default: true */
  autoOpen: boolean;
  /** Fail the test run if any diffs are detected. Default: false */
  failOnDiff: boolean;
  /**
   * Exit 3 from `testivai report` when baselines received no capture this
   * run (coverage-loss gate). Default: true — a baseline nobody compares
   * is silent coverage loss. Set false in config (or pass
   * `--allow-missing` per run) for filtered runs that skip baselines.
   */
  failOnMissing?: boolean;
  /**
   * Layout tolerance in px: auto-pass diffs where every region is a pure
   * element shift (content unchanged) of at most this many pixels per
   * axis — kills sub-pixel layout jitter. Requires element maps
   * (captured by default). Unset/0 = off.
   */
  shiftTolerance?: number;
  /**
   * Attribute names whose VALUES the DOM diff ignores (presence still
   * counts) — for per-run URLs in `src`/`srcset`/`href` that would
   * otherwise poison the noise hint with `attributeChanges`. `blob:`
   * values are always normalized regardless. Default: [].
   */
  volatileAttributes?: string[];
  /**
   * Storage-agnostic upload hook for `report --share`: a shell command
   * template run after share.html is written, with `{file}` replaced by
   * the share file's absolute path. The command's last stdout line is
   * treated as the shared URL. Examples:
   *   "aws s3 cp {file} s3://bucket/reports/ && echo https://…"
   *   "gsutil cp {file} gs://bucket/ && echo https://…"
   *   "rclone copyto {file} remote:reports/share.html && echo …"
   * Local file only when unset (the default).
   */
  shareUploadCommand?: string;
  /** Directory for baselines relative to project root. Default: '.testivai/baselines' */
  baselinesDir?: string;
  /** Directory for report output. Default: 'visual-report' */
  reportDir?: string;
  /**
   * CSS selectors for elements to hide during screenshot capture.
   * Matched elements are set to `visibility: hidden` in both baseline and
   * candidate runs, so dynamic content (version badges, timestamps, ads)
   * never contributes to the diff.
   *
   * Example: ["[data-testivai-ignore]", ".version-badge", "#live-chat"]
   */
  ignoreSelectors?: string[];
  /**
   * Masks: page areas excluded from the pixel diff and hatched in the
   * report (auditable — never silent). Each entry is a CSS selector
   * string (geometry captured by the adapter at capture time) or a
   * geometric region: px numbers, 0–1 ratios, "NN%" strings, or a
   * single-edge shorthand like { "top": 24 }.
   */
  mask?: Array<string | Record<string, number | string>>;
  /**
   * Diff clustering tunables: minSize = noise floor in changed pixels
   * (default 10), mergeDistance = px gap within which nearby regions
   * merge into one (default 12).
   */
  diffRegions?: { minSize?: number; mergeDistance?: number };
  /**
   * Pass tolerance: snapshots whose diff percentage (0-100) is at or below
   * this value are reported as passed instead of changed. Default: 0 —
   * only pixel-identical (after `threshold`) runs pass.
   */
  maxDiffPercent: number;
  /**
   * Absolute variant of the pass tolerance: pass when the number of changed
   * pixels is at or below this count. Unset by default. When both this and
   * maxDiffPercent are set, satisfying either one passes.
   */
  maxDiffPixels?: number;
  /**
   * Auto-pass render noise: when true, a snapshot whose pixels differ but
   * whose DOM is structurally identical (the noise hint) is reported as
   * passed — provided its diff percentage is at or below
   * noiseMaxDiffPercent. Auto-passed snapshots keep their diff image and
   * are labeled in the report. Default: false (hint stays a label).
   */
  noiseAutoPass: boolean;
  /**
   * Upper bound (diff %, 0-100) for noiseAutoPass. A DOM-identical diff
   * larger than this still shows as changed. Default: 1.
   */
  noiseMaxDiffPercent: number;
  /**
   * Stabilize captures: adapters disable CSS animations/transitions, hide
   * the caret, and wait for web fonts before taking the screenshot.
   * Default: true.
   */
  stabilize: boolean;
  /**
   * Standalone mode (`testivai witness <url>`): explicit page paths to
   * capture, resolved against the start URL (e.g. ["/", "/pricing"]).
   * When set, link crawling is skipped. Unset = crawl same-origin links
   * from the start page.
   */
  pages?: string[];
  /** Standalone mode: crawl cap when discovering links. Default: 10. */
  maxPages?: number;
  /** Standalone mode: capture viewport. Default: 1280x800. */
  viewport?: { width: number; height: number };
  /**
   * Read by @testivai/mcp. When true (the default), the approve_snapshot and
   * approve_all tools tell MCP clients to ask a person on every call (Claude
   * Code shows its permission prompt even in auto-approving modes). Set false
   * to let them follow the client's own permission settings instead. The
   * server's --approval-prompt / --no-approval-prompt flag overrides this.
   */
  mcpApprovalPrompt?: boolean;
}

const DEFAULT_CONFIG: LocalConfig = {
  threshold: 0.1,
  autoOpen: true,
  failOnDiff: false,
  failOnMissing: true,
  maxDiffPercent: 0,
  noiseAutoPass: false,
  noiseMaxDiffPercent: 1,
  stabilize: true,
};

const CONFIG_FILENAME = 'config.json';
const CONFIG_DIR = '.testivai';

// Warn once per config path per process: loadLocalConfig is called from the
// CLI, the reporter, and the compare pipeline in the same run, and repeating
// the same warning three times reads like three different problems.
const warnedPaths = new Set<string>();

/**
 * Load local config from `.testivai/config.json`.
 * Returns defaults if the file does not exist.
 *
 * Unknown keys and mistyped values are reported to stderr with a
 * did-you-mean suggestion (see validate-config.ts) — warnings only, never
 * an error. Mistyped values are dropped so the documented defaults apply
 * instead of, say, a string flowing into threshold arithmetic.
 *
 * @param projectRoot - Root of the project (where `.testivai/` lives)
 */
export function loadLocalConfig(projectRoot: string): LocalConfig {
  const configPath = getConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);

    const { warnings, invalidKeys } = validateLocalConfig(parsed);
    if (warnings.length > 0 && !warnedPaths.has(configPath)) {
      warnedPaths.add(configPath);
      for (const warning of warnings) {
        console.warn(`[testivai] config warning: ${warning}`);
      }
    }
    if (parsed !== null && typeof parsed === 'object') {
      for (const key of invalidKeys) {
        delete (parsed as Record<string, unknown>)[key];
      }
    }

    return {
      ...DEFAULT_CONFIG,
      ...parsed,
    };
  } catch (err) {
    // Malformed JSON: fall back to defaults, but say so — silently ignoring
    // the whole file makes every setting in it look broken.
    if (!warnedPaths.has(configPath)) {
      warnedPaths.add(configPath);
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[testivai] config warning: ${configPath} is not valid JSON (${detail}) — using defaults.`);
    }
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Create a default `.testivai/config.json` file.
 * Creates the `.testivai/` directory if it doesn't exist.
 *
 * @param projectRoot - Root of the project
 * @param overrides - Optional config values to override defaults
 * @returns The config that was written
 */
export function createDefaultConfig(
  projectRoot: string,
  overrides?: Partial<LocalConfig>,
): LocalConfig {
  const config: LocalConfig = {
    ...DEFAULT_CONFIG,
    ...overrides,
  };

  const configDir = path.join(projectRoot, CONFIG_DIR);
  fs.mkdirSync(configDir, { recursive: true });

  const configPath = getConfigPath(projectRoot);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  return config;
}

/**
 * Check if a local config file exists.
 */
export function localConfigExists(projectRoot: string): boolean {
  return fs.existsSync(getConfigPath(projectRoot));
}

/**
 * Get the full path to the config file.
 */
export function getConfigPath(projectRoot: string): string {
  return path.join(projectRoot, CONFIG_DIR, CONFIG_FILENAME);
}

/**
 * Get default config values (useful for testing).
 */
export function getDefaultConfig(): LocalConfig {
  return { ...DEFAULT_CONFIG };
}
