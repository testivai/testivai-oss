/**
 * TestivAI Diff Engine — Core comparison loop
 *
 * Originally forked from pixel-buffer-diff (Pbd) by @p01, licensed under MIT.
 * https://github.com/p01/pixel-buffer-diff
 *
 * The core pixel comparison algorithm is preserved exactly.
 * Extended with: ignore regions, size mismatch handling, region detection,
 * and enriched DiffResult.
 */

import type { DiffOptions, DiffResult, DiffRegion, PbdRawResult } from './types';
import { applyIgnoreRegions } from './ignore';
import { applyMaskRects, hatchMaskRects } from './mask';
import { normalizeDimensions } from './resize';
import { detectRegions } from './regions';
import { applyMinimap } from './minimap';

// ── Pbd constants (unchanged) ───────────────────────────────────────────────
const MINIMAP_SCALE = 128;
const _COLOR32_ADDED = 0x03f00cc00;
const _COLOR32_REMOVED = 0x03f0000ff;
const COLOR32_MINIMAP = 0x0207f0000;
const HASH_SPREAD = 0x0f0731337;

// ── Default options ─────────────────────────────────────────────────────────
const DEFAULT_OPTIONS: Required<Pick<DiffOptions, 'threshold' | 'cumulatedThreshold' | 'enableMinimap' | 'detectRegions'>> = {
  threshold: 0.1,
  cumulatedThreshold: 0.5,
  enableMinimap: false,
  detectRegions: false,
};

/**
 * Compare two pixel buffers and produce a diff image.
 *
 * Drop-in compatible with pixelmatch when called as:
 *   diff(img1, img2, output, w, h) → returns DiffResult
 *
 * @param baseline8  - Baseline image pixel data (RGBA, 4 bytes per pixel)
 * @param candidate8 - Candidate image pixel data (RGBA, 4 bytes per pixel)
 * @param diff8      - Output buffer for the diff image (same size as inputs)
 * @param width      - Width of the images in pixels
 * @param height     - Height of the images in pixels
 * @param options    - Comparison options
 * @returns DiffResult with counts, percentages, and optional regions
 */
export function diff(
  baseline8: Uint8Array | Uint8ClampedArray,
  candidate8: Uint8Array | Uint8ClampedArray,
  diff8: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: DiffOptions = {},
): DiffResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // ── Size mismatch handling ──────────────────────────────────────────────
  let sizeMismatch: DiffResult['sizeMismatch'];
  let effectiveWidth = width;
  let effectiveHeight = height;
  let effectiveBaseline = baseline8;
  let effectiveCandidate = candidate8;

  // Dimensions come from `options.dimensions` when the caller knows both;
  // otherwise a length mismatch is read as a height difference at the shared
  // width (normalizeDimensions is public for callers that pre-normalize).
  const expectedLen = width * height * 4;
  const dims = opts.dimensions;
  const dimsDiffer =
    dims !== undefined &&
    (dims.baseline.width !== dims.candidate.width || dims.baseline.height !== dims.candidate.height);
  // With 'pad': the overlap of the two sizes; everything outside it on the
  // canvas is padding and counts as changed (see flagPadding).
  let overlap: { width: number; height: number } | undefined;
  if (dimsDiffer || baseline8.length !== expectedLen || candidate8.length !== expectedLen) {
    if (opts.handleSizeMismatch) {
      const bw = dims ? dims.baseline.width : width;
      const bh = dims ? dims.baseline.height : Math.round(baseline8.length / (width * 4));
      const cw = dims ? dims.candidate.width : width;
      const ch = dims ? dims.candidate.height : Math.round(candidate8.length / (width * 4));

      const normalized = normalizeDimensions(
        baseline8, bw, bh,
        candidate8, cw, ch,
        opts.handleSizeMismatch,
      );

      effectiveBaseline = normalized.normalizedBaseline;
      effectiveCandidate = normalized.normalizedCandidate;
      effectiveWidth = normalized.width;
      effectiveHeight = normalized.height;
      if (bw !== cw || bh !== ch) {
        sizeMismatch = normalized.sizeMismatch;
        if (opts.handleSizeMismatch === 'pad') {
          overlap = { width: Math.min(bw, cw), height: Math.min(bh, ch) };
        }
      }

      // Re-create diff buffer if size changed
      if (diff8.length !== effectiveWidth * effectiveHeight * 4) {
        diff8 = new Uint8ClampedArray(effectiveWidth * effectiveHeight * 4);
      }
    } else {
      throw new Error(
        `Buffer size mismatch: expected ${expectedLen} bytes (${width}×${height}×4), ` +
        `got baseline=${baseline8.length}, candidate=${candidate8.length}. ` +
        `Set handleSizeMismatch option to 'pad', 'crop', or 'error'.`
      );
    }
  }

  // ── Ignore regions ──────────────────────────────────────────────────────
  if (opts.ignoreRegions && opts.ignoreRegions.length > 0) {
    // Clone buffers so we don't mutate originals
    effectiveBaseline = new Uint8ClampedArray(effectiveBaseline);
    effectiveCandidate = new Uint8ClampedArray(effectiveCandidate);
    applyIgnoreRegions(effectiveBaseline, effectiveCandidate, effectiveWidth, effectiveHeight, opts.ignoreRegions);
  }

  // ── Masks: equalize before diffing, hatch the output after ─────────────
  const masks = opts.masks ?? [];
  if (masks.length > 0) {
    effectiveBaseline = new Uint8ClampedArray(effectiveBaseline);
    applyMaskRects(effectiveBaseline, effectiveCandidate, effectiveWidth, effectiveHeight, masks);
  }

  // ── Core Pbd diff loop (basic mode — pixel-level YIQ comparison) ──────
  const raw = pbdDiffCore(
    effectiveBaseline,
    effectiveCandidate,
    diff8,
    effectiveWidth,
    effectiveHeight,
    opts.threshold,
    opts.cumulatedThreshold,
    opts.enableMinimap,
  );

  // ── Padding counts as changed: a page that grew or shrank is a change
  //    whatever the added rows contain (the core compares RGB only, so black
  //    content over the transparent black pad would otherwise be invisible) ─
  let diffCount = raw.diff;
  if (overlap) {
    diffCount += flagPadding(diff8, effectiveWidth, effectiveHeight, overlap.width, overlap.height);
  }

  // ── Compute extended result ─────────────────────────────────────────────
  const totalPixels = effectiveWidth * effectiveHeight;
  const diffPercent = totalPixels > 0 ? (diffCount / totalPixels) * 100 : 0;
  const isIdentical = diffCount === 0;

  const result: DiffResult = {
    diffCount,
    cumulatedDiff: raw.cumulatedDiff,
    hash: raw.hash,
    diffPercent,
    totalPixels,
    isIdentical,
  };

  if (sizeMismatch) {
    result.sizeMismatch = sizeMismatch;
  }

  // ── Region detection (before hatching — hatch pixels must not cluster,
  //    and before the context wash — detection keys on alpha > 0) ─────────
  if (opts.detectRegions && !isIdentical) {
    result.regions = detectRegions(diff8, effectiveWidth, effectiveHeight, opts.regionOptions ?? {});
    outlineRegions(diff8, effectiveWidth, effectiveHeight, result.regions);
  }

  // ── Context wash: unchanged pixels become a light grayscale of the
  //    baseline so the heatmap reads in place, not on a void ──────────────
  washBackground(effectiveBaseline, diff8, effectiveWidth, effectiveHeight);

  // ── Hatch masked areas in the diff output (auditable, never silent) ─────
  if (masks.length > 0) {
    hatchMaskRects(diff8, effectiveWidth, effectiveHeight, masks);
  }

  return result;
}

/**
 * Paint every canvas pixel outside the overlap of the two sizes (the padding
 * added by normalizeDimensions 'pad') as full-strength heat, unless the core
 * loop already flagged it, and return how many were newly flagged. Runs
 * before region detection, so the padded strip clusters into a region.
 */
function flagPadding(
  diff8: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  overlapWidth: number,
  overlapHeight: number,
): number {
  let flagged = 0;
  for (let y = 0; y < height; y++) {
    for (let x = y < overlapHeight ? overlapWidth : 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (diff8[i + 3] !== 0) continue; // already heat
      diff8[i] = 211;     // deep red rgb(211, 47, 47): the strongest heat
      diff8[i + 1] = 47;
      diff8[i + 2] = 47;
      diff8[i + 3] = 255;
      flagged++;
    }
  }
  return flagged;
}

/**
 * Fill every still-transparent diff pixel with a washed-out grayscale of
 * the baseline (≈15% strength lifted to near-white). Gives the heatmap
 * spatial context — you can see WHERE on the page the heat sits — while
 * keeping enough contrast that yellow→red pixels pop. Runs after region
 * detection (which keys on alpha > 0) and leaves heat/outline/minimap
 * pixels untouched.
 */
function washBackground(
  baseline8: Uint8Array | Uint8ClampedArray,
  diff8: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): void {
  const len = width * height * 4;
  for (let i = 0; i < len; i += 4) {
    if (diff8[i + 3] !== 0) continue; // heat / outline / minimap pixel
    const luma = 0.299 * baseline8[i] + 0.587 * baseline8[i + 1] + 0.114 * baseline8[i + 2];
    const v = (216 + luma * 0.15) | 0; // 216..254 — faint but legible
    diff8[i] = v;
    diff8[i + 1] = v;
    diff8[i + 2] = v;
    diff8[i + 3] = 255;
  }
}

/**
 * Stroke a 2px deep-red rectangle around each detected region so even a
 * few changed pixels are findable at page zoom.
 */
function outlineRegions(
  diff8: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  regions: DiffRegion[],
): void {
  const setPx = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    diff8[i] = 211;     // deep red rgb(211, 47, 47)
    diff8[i + 1] = 47;
    diff8[i + 2] = 47;
    diff8[i + 3] = 255;
  };
  for (const r of regions) {
    const x0 = r.x - 2, y0 = r.y - 2;
    const x1 = r.x + r.width + 1, y1 = r.y + r.height + 1;
    for (let s = 0; s < 2; s++) {
      for (let x = x0 + s; x <= x1 - s; x++) { setPx(x, y0 + s); setPx(x, y1 - s); }
      for (let y = y0 + s; y <= y1 - s; y++) { setPx(x0 + s, y); setPx(x1 - s, y); }
    }
  }
}

/**
 * Core Pbd diff loop — pixel-level YIQ comparison.
 * Algorithm is preserved exactly from pixel-buffer-diff.
 * @internal
 */
function pbdDiffCore(
  baseline8: Uint8Array | Uint8ClampedArray,
  candidate8: Uint8Array | Uint8ClampedArray,
  diff8: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
  cumulatedThreshold: number,
  enableMinimap: boolean,
): PbdRawResult {
  const area = width * height;
  const _b8l = baseline8.length;

  // Maximum acceptable square distance between two colors;
  // 35215 is the maximum possible value for the YIQ difference metric
  const deltaThreshold = threshold * threshold * 35215;

  // Use ArrayBuffer views for 32-bit access
  const bBuffer = baseline8.buffer;
  const bOffset = baseline8.byteOffset;
  const cBuffer = candidate8.buffer;
  const cOffset = candidate8.byteOffset;
  const dBuffer = diff8.buffer;
  const dOffset = diff8.byteOffset;
  const baseline32 = new Uint32Array(bBuffer, bOffset, area);
  const candidate32 = new Uint32Array(cBuffer, cOffset, area);
  const diff32 = new Uint32Array(dBuffer, dOffset, area);

  let b8i = 0;
  let b32i = 0;
  let d32i = 0;
  let diffCount = 0;
  let hash = 0;
  let hashStart = 0;
  let cumulatedDiff = 0;

  // Heatmap normalization: deltas run from the configured threshold up to
  // the YIQ metric's maximum (35215). sqrt spreads perception so subtle
  // diffs are already visibly yellow instead of hiding near-transparent.
  const deltaRange = Math.max(1, 35215 - deltaThreshold);

  // Minimap tracking
  const miniHeight = Math.ceil(height / MINIMAP_SCALE);
  const miniWidth = Math.ceil(width / MINIMAP_SCALE);
  const miniMap = new Uint8ClampedArray(miniWidth * miniHeight);
  const maxDimension = Math.max(width, height);
  const maxMiniDimension = Math.max(miniWidth, miniHeight);
  const axisMiniIndex = new Uint32Array(maxDimension);

  let miniIndex = 0;
  for (let i = 0; i < maxMiniDimension; i++) {
    axisMiniIndex.fill(i, miniIndex, Math.min(miniIndex + MINIMAP_SCALE, maxDimension));
    miniIndex += MINIMAP_SCALE;
  }

  // ── Per-pixel comparison ────────────────────────────────────────────────
  for (let y = 0; y < height; y++) {
    const miniIndexY = axisMiniIndex[y] * miniWidth;
    let hashIndex = (y ^ HASH_SPREAD) * HASH_SPREAD;

    for (let x = 0; x < width; x++, d32i++, b32i++, b8i += 4, hashIndex++) {
      // Quick check against the Uint32
      if (baseline32[b32i] === candidate32[b32i]) {
        continue;
      }

      // Get the r,g,b -> y,i,q => YIQ square delta
      const dr = candidate8[b8i] - baseline8[b8i];
      const dg = candidate8[b8i + 1] - baseline8[b8i + 1];
      const db = candidate8[b8i + 2] - baseline8[b8i + 2];

      const dy = dr * 0.29889531 + dg * 0.58662247 + db * 0.11448223;
      const di = dr * 0.59597799 - dg * 0.27417610 - db * 0.32180189;
      const dq = dr * 0.21147017 - dg * 0.52261711 + db * 0.31114694;

      const delta = dy * dy * 0.5053 + di * di * 0.299 + dq * dq * 0.1957;
      if (delta > deltaThreshold) {
        miniMap[miniIndexY + axisMiniIndex[x]]++;
        diffCount++;
        const dyAbs = Math.abs(dy);
        cumulatedDiff += dyAbs;
        // Heatmap pixel: fully opaque, colored by difference magnitude —
        // yellow (subtle) → orange → red (strong). Obvious at any zoom,
        // unlike the old direction-colored pixels with ≤75% alpha.
        const t = Math.sqrt(Math.min(1, (delta - deltaThreshold) / deltaRange));
        let hr: number, hg: number, hb: number;
        if (t < 0.5) {
          const u = t * 2; // yellow (255,235,59) → orange (255,152,0)
          hr = 255; hg = (235 - 83 * u) | 0; hb = (59 - 59 * u) | 0;
        } else {
          const u = (t - 0.5) * 2; // orange (255,152,0) → red (211,47,47)
          hr = (255 - 44 * u) | 0; hg = (152 - 105 * u) | 0; hb = (47 * u) | 0;
        }
        diff32[d32i] = (255 << 24) | (hb << 16) | (hg << 8) | hr;

        if (hash === 0) {
          hashStart = hashIndex;
        }
        hash += hashIndex;
      }
    }
  }

  hash -= hashStart;
  cumulatedDiff /= 256;

  // Apply minimap overlay
  if (enableMinimap) {
    applyMinimap(diff32, miniMap, miniWidth, miniHeight, width, height, MINIMAP_SCALE, COLOR32_MINIMAP);
  }

  // If cumulated diff is within threshold, treat as identical
  if (cumulatedDiff <= cumulatedThreshold) {
    return { diff: 0, cumulatedDiff: 0, hash: 0 };
  }

  return { diff: diffCount, cumulatedDiff, hash };
}
