/**
 * TestivAI Diff Engine Types
 *
 * Originally forked from pixel-buffer-diff (Pbd) by @p01.
 * Extended with ignore regions, size mismatch handling,
 * region detection, and TypeScript support.
 */

export interface DiffOptions {
  /** Individual pixel matching threshold (0-1). Default: 0.1 */
  threshold?: number;
  /** Cumulated pixel matching threshold for anti-aliasing filtering. Default: 0.5 */
  cumulatedThreshold?: number;
  /** Enable low-resolution minimap overlay on diff output. Default: false */
  enableMinimap?: boolean;
  /** Coordinate-based regions to ignore during comparison */
  ignoreRegions?: IgnoreRegion[];
  /** Detect and return bounding boxes of changed regions. Default: false */
  detectRegions?: boolean;
  /** Clustering tunables used when detectRegions is enabled. */
  regionOptions?: RegionOptions;
  /**
   * Resolved mask rects: excluded from diffing (candidate copied over
   * baseline) AND hatched in the diff output for auditability.
   */
  masks?: import('./mask').MaskRect[];
  /** How to handle size mismatches between baseline and candidate */
  handleSizeMismatch?: 'pad' | 'crop' | 'error';
  /**
   * The dimensions of each buffer, for callers that know both (a decoded
   * PNG pair). With `handleSizeMismatch`, the engine normalizes them itself,
   * a width difference included; without this, a length mismatch is read as
   * a height difference at the shared `width`. With 'pad', every padded
   * pixel counts as changed and is painted as full-strength heat, so content
   * added below or beside the baseline is a change whatever its color.
   * `diff8` must then hold max width × max height pixels: a smaller buffer
   * is replaced internally and the caller does not see the image.
   */
  dimensions?: { baseline: { width: number; height: number }; candidate: { width: number; height: number } };
}

export interface RegionOptions {
  /** Minimum changed pixels for a region to count (noise floor). Default 10. */
  minSize?: number;
  /** Merge regions whose boxes are within this many px. Default 12. */
  mergeDistance?: number;
}

export interface IgnoreRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffResult {
  /** Number of pixels that exceeded the threshold */
  diffCount: number;
  /** Cumulated difference of every pixel change (for anti-aliasing detection) */
  cumulatedDiff: number;
  /** Numeric hash of pixel changes for deduplication */
  hash: number;
  /** Percentage of pixels that differ (0-100) */
  diffPercent: number;
  /** Total number of pixels compared */
  totalPixels: number;
  /** True if images are identical (within thresholds) */
  isIdentical: boolean;
  /** Bounding boxes of change clusters (if detectRegions was enabled) */
  regions?: DiffRegion[];
  /** Size mismatch info (if dimensions differed and were normalized) */
  sizeMismatch?: SizeMismatch;
}

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Number of changed pixels within this region's bounding box */
  diffPixels: number;
  /** Percentage of changed pixels within this region's bounding box */
  diffPercent: number;
}

export interface SizeMismatch {
  baseline: { width: number; height: number };
  candidate: { width: number; height: number };
  normalized: { width: number; height: number };
}

/**
 * Raw result from the core Pbd diff loop (before extensions).
 * @internal
 */
export interface PbdRawResult {
  diff: number;
  cumulatedDiff: number;
  hash: number;
}
