/**
 * TestivAI Local Baseline Store
 *
 * Manages baseline screenshots on disk for local visual regression testing.
 *
 * Directory structure:
 *   .testivai/
 *   ├── baselines/{name}/screenshot.png, metadata.json, dom.html?, .previous/
 *   └── temp/{name}/screenshot.png, dom.html?   (gitignored)
 *
 * `dom.html` is optional — written when the adapter captures DOM alongside
 * the screenshot. Used by the DOM-diff noise hint in the local report.
 */

import * as fs from 'fs';
import * as path from 'path';
import { type CaptureEnvironment, readEnvironment } from '../capture/environment';
import { type CaptureHealth, parseHealth } from '../capture/health';

/**
 * Resolve the baselines directory: explicit override → config.json
 * `baselinesDir` → the default `.testivai/baselines`.
 *
 * A literal `{platform}` token is replaced with `process.platform`
 * (darwin / linux / win32), giving cross-platform teams per-OS baselines
 * without any wrapper scripts:
 *
 *   { "baselinesDir": ".testivai/baselines-{platform}" }
 *
 * mac devs and linux CI then gate against their own renders, instead of
 * flagging every snapshot on font-rasterization differences.
 */
export function resolveBaselinesDir(projectRoot: string, override?: string): string {
  let dir = override;
  if (!dir) {
    try {
      const raw = fs.readFileSync(path.join(projectRoot, '.testivai', 'config.json'), 'utf-8');
      const cfg = JSON.parse(raw);
      if (typeof cfg.baselinesDir === 'string' && cfg.baselinesDir.length > 0) {
        dir = cfg.baselinesDir;
      }
    } catch {
      // no config / malformed → default
    }
  }
  if (!dir) dir = path.join('.testivai', 'baselines');
  dir = dir.split('{platform}').join(process.platform);
  return path.isAbsolute(dir) ? dir : path.join(projectRoot, dir);
}

export interface BaselineMetadata {
  name: string;
  createdAt: string;
  updatedAt: string;
  width?: number;
  height?: number;
  approvedBy?: string;
  /**
   * The environment the approved capture was taken in (capture provenance),
   * frozen from the capture's temp metadata.json on approve. Absent for
   * baselines approved before it was recorded, or from an adapter that does
   * not record it.
   */
  environment?: CaptureEnvironment;
  /**
   * What failed to load when the approved capture was taken (capture
   * health), frozen from the capture's temp metadata.json on approve, so
   * every compare against an unhealthy baseline can say so. Absent when the
   * capture recorded none (not checked).
   */
  health?: CaptureHealth;
}

export class BaselineStore {
  private readonly baselinesDir: string;
  private readonly tempDir: string;

  constructor(readonly projectRoot: string, baselinesDirOverride?: string) {
    this.baselinesDir = resolveBaselinesDir(projectRoot, baselinesDirOverride);
    this.tempDir = path.join(projectRoot, '.testivai', 'temp');
  }

  /**
   * Check if a baseline exists for the given snapshot name.
   */
  exists(name: string): boolean {
    const screenshotPath = this.getBaselineScreenshotPath(name);
    return fs.existsSync(screenshotPath);
  }

  /**
   * Read a baseline screenshot as a Buffer.
   * Returns null if the baseline does not exist.
   */
  read(name: string): Buffer | null {
    const screenshotPath = this.getBaselineScreenshotPath(name);
    if (!fs.existsSync(screenshotPath)) {
      return null;
    }
    return fs.readFileSync(screenshotPath);
  }

  /**
   * Read baseline metadata.
   * Returns null if the baseline does not exist.
   */
  readMetadata(name: string): BaselineMetadata | null {
    const metadataPath = this.getBaselineMetadataPath(name);
    if (!fs.existsSync(metadataPath)) {
      return null;
    }
    const raw = fs.readFileSync(metadataPath, 'utf-8');
    return JSON.parse(raw) as BaselineMetadata;
  }

  /**
   * Write a screenshot and metadata to the baseline directory.
   * Creates the directory if it doesn't exist.
   *
   * @param dom - Optional DOM HTML captured at the same time as the
   *   screenshot. Stored as `dom.html` for the noise-hint compare.
   */
  write(name: string, screenshot: Buffer, metadata?: Partial<BaselineMetadata>, dom?: string): void {
    const baselineDir = this.getBaselineDir(name);
    fs.mkdirSync(baselineDir, { recursive: true });

    // Write screenshot
    fs.writeFileSync(this.getBaselineScreenshotPath(name), screenshot);

    // Write DOM if provided
    if (dom !== undefined) {
      fs.writeFileSync(this.getBaselineDomPath(name), dom);
    }

    // Write metadata
    const now = new Date().toISOString();
    const meta: BaselineMetadata = {
      name,
      createdAt: now,
      updatedAt: now,
      ...metadata,
    };
    fs.writeFileSync(this.getBaselineMetadataPath(name), JSON.stringify(meta, null, 2));
  }

  /**
   * Read the baseline DOM HTML if one was captured.
   * Returns null when no DOM file exists for this snapshot.
   */
  readDom(name: string): string | null {
    const domPath = this.getBaselineDomPath(name);
    if (!fs.existsSync(domPath)) return null;
    return fs.readFileSync(domPath, 'utf-8');
  }

  /**
   * Approve a temp screenshot as the new baseline.
   * Backs up the previous baseline to `.previous/` if one exists.
   */
  approve(name: string): void {
    const tempScreenshot = this.getTempScreenshotPath(name);
    if (!fs.existsSync(tempScreenshot)) {
      throw new Error(
        `No temp screenshot found for "${name}". Run your tests first to generate screenshots.`
      );
    }

    const baselineDir = this.getBaselineDir(name);
    const previousDir = path.join(baselineDir, '.previous');
    const currentScreenshot = this.getBaselineScreenshotPath(name);
    const currentMetadata = this.getBaselineMetadataPath(name);
    const currentDom = this.getBaselineDomPath(name);
    const tempDom = this.getTempDomPath(name);
    const currentElements = path.join(this.getBaselineDir(name), 'elements.json');
    const tempElements = path.join(this.getTempDir(), name, 'elements.json');

    // Backup current baseline if it exists
    if (fs.existsSync(currentScreenshot)) {
      fs.mkdirSync(previousDir, { recursive: true });
      fs.copyFileSync(currentScreenshot, path.join(previousDir, 'screenshot.png'));
      if (fs.existsSync(currentMetadata)) {
        fs.copyFileSync(currentMetadata, path.join(previousDir, 'metadata.json'));
      }
      if (fs.existsSync(currentDom)) {
        fs.copyFileSync(currentDom, path.join(previousDir, 'dom.html'));
      }
      if (fs.existsSync(currentElements)) {
        fs.copyFileSync(currentElements, path.join(previousDir, 'elements.json'));
      }
    }

    // Copy temp to baseline
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.copyFileSync(tempScreenshot, currentScreenshot);
    if (fs.existsSync(tempDom)) {
      fs.copyFileSync(tempDom, currentDom);
    } else if (fs.existsSync(currentDom)) {
      // Temp had no DOM but baseline did — drop the stale DOM rather
      // than keep an inconsistent pair.
      fs.rmSync(currentDom);
    }
    if (fs.existsSync(tempElements)) {
      fs.copyFileSync(tempElements, currentElements);
    } else if (fs.existsSync(currentElements)) {
      // Same stale-drop semantics as dom.html: an element map from an
      // older approval must not attribute regions against a new baseline.
      fs.rmSync(currentElements);
    }

    // Update metadata. The capture's environment and health are frozen into
    // the baseline; a capture without one leaves the baseline without one (the
    // previous baseline's would describe a screenshot it did not take).
    const now = new Date().toISOString();
    const existingMeta = this.readMetadata(name);
    const tempMeta = this.readTempMetadata(name);
    const environment = readEnvironment(tempMeta?.environment);
    const health = parseHealth(tempMeta?.health);
    const meta: BaselineMetadata = {
      name,
      createdAt: existingMeta?.createdAt ?? now,
      updatedAt: now,
      approvedBy: 'local',
      ...(environment ? { environment } : {}),
      ...(health ? { health } : {}),
    };
    fs.writeFileSync(currentMetadata, JSON.stringify(meta, null, 2));
  }

  /**
   * Find the baseline name whose `.previous/screenshot.png` has the newest
   * modification time. Returns null when no baseline has a `.previous/` backup.
   */
  findLatestUndoable(): string | null {
    if (!fs.existsSync(this.baselinesDir)) return null;
    let latestName: string | null = null;
    let latestMtime = 0;
    for (const entry of fs.readdirSync(this.baselinesDir)) {
      const entryPath = path.join(this.baselinesDir, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;
      const prevScreenshot = path.join(entryPath, '.previous', 'screenshot.png');
      if (fs.existsSync(prevScreenshot)) {
        const mtime = fs.statSync(prevScreenshot).mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestName = entry;
        }
      }
    }
    return latestName;
  }

  /**
   * Undo the last approve by restoring the `.previous/` backup.
   */
  undo(name: string): void {
    const baselineDir = this.getBaselineDir(name);
    const previousDir = path.join(baselineDir, '.previous');

    if (!fs.existsSync(previousDir)) {
      throw new Error(
        `No previous baseline found for "${name}". Cannot undo.`
      );
    }

    const previousScreenshot = path.join(previousDir, 'screenshot.png');
    const previousMetadata = path.join(previousDir, 'metadata.json');
    const previousDom = path.join(previousDir, 'dom.html');
    const currentScreenshot = this.getBaselineScreenshotPath(name);
    const currentMetadata = this.getBaselineMetadataPath(name);
    const currentDom = this.getBaselineDomPath(name);

    // Restore previous screenshot
    if (fs.existsSync(previousScreenshot)) {
      fs.copyFileSync(previousScreenshot, currentScreenshot);
    }

    // Restore previous metadata
    if (fs.existsSync(previousMetadata)) {
      fs.copyFileSync(previousMetadata, currentMetadata);
    }

    // Restore previous DOM (or remove the current one if no previous existed)
    if (fs.existsSync(previousDom)) {
      fs.copyFileSync(previousDom, currentDom);
    } else if (fs.existsSync(currentDom)) {
      fs.rmSync(currentDom);
    }

    // Remove .previous directory
    fs.rmSync(previousDir, { recursive: true, force: true });
  }

  /**
   * List all baseline names.
   */
  list(): string[] {
    if (!fs.existsSync(this.baselinesDir)) {
      return [];
    }
    return fs.readdirSync(this.baselinesDir).filter((entry) => {
      const entryPath = path.join(this.baselinesDir, entry);
      return fs.statSync(entryPath).isDirectory();
    });
  }

  /**
   * Write a temp screenshot (captured during a test run).
   *
   * @param dom - Optional DOM HTML captured at the same time as the
   *   screenshot. Stored as `dom.html` next to the screenshot.
   */
  writeTemp(name: string, screenshot: Buffer, dom?: string): void {
    const tempDir = path.join(this.tempDir, name);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(this.getTempScreenshotPath(name), screenshot);
    if (dom !== undefined) {
      fs.writeFileSync(this.getTempDomPath(name), dom);
    }
  }

  /**
   * Merge fields into the capture's temp metadata.json (creating it), so
   * each part of an adapter (masks, environment…) adds its own without
   * losing the others. A malformed file is replaced.
   */
  writeTempMetadata(name: string, fields: Record<string, unknown>): void {
    const dir = path.join(this.tempDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const merged = { ...(this.readTempMetadata(name) ?? {}), ...fields };
    fs.writeFileSync(this.getTempMetadataPath(name), JSON.stringify(merged, null, 2));
  }

  /** The capture's temp metadata.json, or null when absent or malformed. */
  readTempMetadata(name: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.getTempMetadataPath(name), 'utf-8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /**
   * Read a temp screenshot.
   */
  readTemp(name: string): Buffer | null {
    const tempPath = this.getTempScreenshotPath(name);
    if (!fs.existsSync(tempPath)) {
      return null;
    }
    return fs.readFileSync(tempPath);
  }

  /**
   * Read the temp DOM HTML if one was captured.
   * Returns null when no temp DOM file exists for this snapshot.
   */
  readTempDom(name: string): string | null {
    const domPath = this.getTempDomPath(name);
    if (!fs.existsSync(domPath)) return null;
    return fs.readFileSync(domPath, 'utf-8');
  }

  /**
   * List all temp snapshot names.
   */
  listTemp(): string[] {
    if (!fs.existsSync(this.tempDir)) {
      return [];
    }
    return fs.readdirSync(this.tempDir).filter((entry) => {
      const entryPath = path.join(this.tempDir, entry);
      return fs.statSync(entryPath).isDirectory();
    });
  }

  /**
   * Clear all temp files.
   */
  clearTemp(): void {
    if (fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  getBaselineDir(name: string): string {
    return path.join(this.baselinesDir, name);
  }

  getBaselineScreenshotPath(name: string): string {
    return path.join(this.baselinesDir, name, 'screenshot.png');
  }

  getBaselineMetadataPath(name: string): string {
    return path.join(this.baselinesDir, name, 'metadata.json');
  }

  getBaselineDomPath(name: string): string {
    return path.join(this.baselinesDir, name, 'dom.html');
  }

  getTempScreenshotPath(name: string): string {
    return path.join(this.tempDir, name, 'screenshot.png');
  }

  getTempDomPath(name: string): string {
    return path.join(this.tempDir, name, 'dom.html');
  }

  getTempMetadataPath(name: string): string {
    return path.join(this.tempDir, name, 'metadata.json');
  }

  getBaselinesDir(): string {
    return this.baselinesDir;
  }

  getTempDir(): string {
    return this.tempDir;
  }
}
