/**
 * TestivAI Report — Compare all snapshots
 *
 * Diffs all temp captures against baselines using the Phase 1 diff engine.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import { diff as diffEngine } from '../diff';
import { domDiff } from '../diff/dom-diff';
import { BaselineStore, resolveBaselinesDir } from '../baselines/store';
import type { SnapshotDomSignal, SnapshotResult, SnapshotStatus } from './results';
import { diffShape } from './diff-shape';
import {
  type CapturedMaskRect,
  type MaskSpec,
  resolveMasks,
} from '../diff/mask';
import type { RegionOptions } from '../diff/types';
import { type EnvironmentPolicy, readEnvironment } from '../capture/environment';
import { diffEnvironments } from './environment';
import {
  attributeRegions,
  compareStyleHashes,
  detectPageShift,
  parseElementMap,
  type ElementMapEntry,
} from '../diff/attribution';

export interface CompareOptions {
  threshold?: number;
  projectRoot: string;
  reportDir: string;
  /**
   * Pass criteria — how much visual difference still counts as passed.
   * Defaults preserve strict behavior: any pixel the diff engine flags
   * marks the snapshot changed.
   */
  passCriteria?: PassCriteria;
  /**
   * Global masks (from .testivai/config.json `mask`). Merged with any
   * per-call masks recorded in the capture's metadata.
   */
  mask?: MaskSpec[];
  /** Region clustering tunables (config `diffRegions`). */
  diffRegions?: RegionOptions;
  /**
   * Attribute names whose values are ignored by the DOM diff (config
   * `volatileAttributes`) — for per-run URLs in `src`/`srcset`/`href`
   * that would otherwise poison the noise hint.
   */
  volatileAttributes?: string[];
  /**
   * config `environmentPolicy`. 'strict' makes a snapshot whose rendering
   * environment changed since the baseline changed, whatever its pixels
   * say; 'warn' (default) and 'separate' never change a status here.
   */
  environmentPolicy?: EnvironmentPolicy;
}

/** The mask-related slice of a capture's metadata.json (all optional). */
interface CaptureMaskMetadata {
  /** Per-call geometric/selector mask specs recorded by the adapter. */
  masks?: MaskSpec[];
  /** Per-call selector masks (kept separate for the audit trail). */
  maskSelectors?: string[];
  /** Selector geometry captured via getBoundingClientRect at capture time. */
  maskRects?: CapturedMaskRect[];
}

function readElementMap(projectRoot: string, kind: 'baselines' | 'temp', name: string): ElementMapEntry[] {
  const p =
    kind === 'baselines'
      ? path.join(resolveBaselinesDir(projectRoot), name, 'elements.json')
      : path.join(projectRoot, '.testivai', 'temp', name, 'elements.json');
  try {
    return parseElementMap(JSON.parse(fs.readFileSync(p, 'utf-8')));
  } catch {
    return []; // absent or malformed map never breaks the compare
  }
}

function readTempMaskMetadata(projectRoot: string, name: string): CaptureMaskMetadata {
  const metaPath = path.join(projectRoot, '.testivai', 'temp', name, 'metadata.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as CaptureMaskMetadata) : {};
  } catch {
    return {}; // absent or malformed metadata never breaks the compare
  }
}

export interface PassCriteria {
  /** Pass when diff percentage (0-100) is at or below this. Default 0. */
  maxDiffPercent?: number;
  /** Pass when changed-pixel count is at or below this. Unset = ignored. */
  maxDiffPixels?: number;
  /**
   * Auto-pass likely render noise up to noiseMaxDiffPercent: only when the
   * DOM is identical (dom.noiseHint) AND the computed styles were compared
   * and match (dom.styleCheck 'match') AND the diff is not concentrated in
   * one area (see diffShape). A diff whose styles were not compared
   * ('unavailable' or missing) or changed ('mismatch'), or whose regions all
   * sit in one area (a bad capture, or a change the style check does not
   * cover), stays 'changed' for a human. Default false.
   */
  noiseAutoPass?: boolean;
  /** Upper bound (diff %, 0-100) for noiseAutoPass. Default 1. */
  noiseMaxDiffPercent?: number;
  /**
   * Layout tolerance in px: auto-pass a changed snapshot when EVERY diff
   * region is a pure element shift (classification 'shift' — content
   * unchanged, element just moved) of at most this many pixels in each
   * axis. Kills sub-pixel/rounding layout jitter without masking content
   * changes: any region classified 'change', any unattributed region, or
   * any shift beyond the tolerance keeps the snapshot 'changed'.
   * Unset/0 = off.
   */
  shiftTolerance?: number;
}

/**
 * Compare all temp screenshots against their baselines.
 *
 * @returns Array of SnapshotResult for each snapshot
 */
export function compareAll(options: CompareOptions): SnapshotResult[] {
  const { projectRoot, reportDir, threshold = 0.1, passCriteria = {}, diffRegions } = options;
  const store = new BaselineStore(projectRoot);
  const tempNames = store.listTemp();
  const results: SnapshotResult[] = [];

  const imagesDir = path.join(reportDir, 'images');

  for (const name of tempNames) {
    const snapshotImagesDir = path.join(imagesDir, name);
    fs.mkdirSync(snapshotImagesDir, { recursive: true });

    const tempBuffer = store.readTemp(name);
    if (!tempBuffer) continue;

    // Write current image to report
    const currentPath = path.join(snapshotImagesDir, 'current.png');
    fs.writeFileSync(currentPath, tempBuffer);

    if (!store.exists(name)) {
      // New snapshot — no baseline to compare against
      results.push({
        name,
        status: 'new',
        diffPercent: 0,
        diffCount: 0,
        totalPixels: 0,
        currentPath: `images/${name}/current.png`,
      });
      continue;
    }

    // Read baseline
    const baselineBuffer = store.read(name)!;
    const baselinePath = path.join(snapshotImagesDir, 'baseline.png');
    fs.writeFileSync(baselinePath, baselineBuffer);

    // Parse raw RGBA from PNG buffers
    // For now, we compare raw buffers directly. In a real implementation
    // we'd decode PNGs to RGBA pixel data. Since temp/baseline are raw
    // screenshots from the browser, we need to handle the PNG decoding.
    // For simplicity and zero-dep, we do a byte-level comparison first,
    // then fall back to diff engine for actual pixel data.
    const captureMeta = readTempMaskMetadata(projectRoot, name);
    const result = compareBuffers(
      baselineBuffer,
      tempBuffer,
      name,
      snapshotImagesDir,
      threshold,
      {
        configMasks: options.mask ?? [],
        callMasks: [
          ...(captureMeta.masks ?? []),
          ...(captureMeta.maskSelectors ?? []),
        ],
        capturedRects: captureMeta.maskRects,
        regionOptions: diffRegions,
      },
    );

    // Baseline provenance: when this baseline was last approved/added.
    const baselineMeta = store.readMetadata(name);
    if (baselineMeta) {
      result.baselineApprovedAt = baselineMeta.updatedAt ?? baselineMeta.createdAt;
    }

    // Capture provenance: the environment each side was captured in. Only
    // when both recorded one: an unrecorded side is unknown, not a change.
    const baselineEnv = readEnvironment(baselineMeta?.environment);
    const candidateEnv = readEnvironment(store.readTempMetadata(name)?.environment);
    if (baselineEnv && candidateEnv) {
      const { delta, renderingDelta } = diffEnvironments(baselineEnv, candidateEnv);
      result.environment = delta.length > 0
        ? { delta, renderingDelta, baseline: baselineEnv, candidate: candidateEnv }
        : { delta, renderingDelta };
      // strict: the environment changed, so the baseline no longer gates
      // this capture, even when the pixels happen to match.
      if (options.environmentPolicy === 'strict' && renderingDelta.length > 0) {
        result.status = 'changed';
        result.environment.policy = 'strict';
      }
    }

    // DOM-level signal. Only meaningful when both sides captured DOM.
    // Computed whenever the two files differ at all (pixels, dimensions, or
    // a re-encode with identical pixels), so a passed snapshot whose DOM
    // changed can say so. Byte-identical 'passed' skips the work —
    // identical bytes are already the strongest possible signal.
    if (result.status === 'changed') {
      const baselineDom = store.readDom(name);
      const candidateDom = store.readTempDom(name);
      const domSignal = computeDomSignal(baselineDom, candidateDom, options.volatileAttributes);

      // Element attribution + shift classification (element maps are
      // optional; without them regions pass through untouched).
      const baselineElements = readElementMap(projectRoot, 'baselines', name);
      const candidateElements = readElementMap(projectRoot, 'temp', name);

      // Style fingerprint: a stylesheet-only change has an identical DOM
      // but different computed styles — pixels + identical DOM used to
      // read as "likely render noise" (a documented false negative).
      // A mismatch clears the hint and is surfaced as an explicit,
      // attributed "styles changed" signal. Without comparable digests
      // (styleCheck 'unavailable') the hint stays set, but a
      // stylesheet-only change is not ruled out: the report labels that
      // case "styles not compared" and noiseAutoPass never passes it.
      if (domSignal) {
        const styleComparison = compareStyleHashes(baselineElements, candidateElements);
        domSignal.styleCheck = styleComparison.status;
        if (styleComparison.status === 'mismatch') {
          domSignal.styleChanges = {
            count: styleComparison.changed.length,
            elements: styleComparison.changed.slice(0, 10),
          };
          domSignal.noiseHint = false;
        }
        result.dom = domSignal;
      }
      if (result.regions && result.regions.length > 0) {
        result.regions = attributeRegions(result.regions, baselineElements, candidateElements);
      }
      const pageShift = detectPageShift(baselineElements, candidateElements);
      if (pageShift) {
        result.pageShift = pageShift;
      }

      applyPassCriteria(result, passCriteria);
    }

    results.push(result);
  }

  return results;
}

/**
 * Turn a 'changed' result into 'passed' when it satisfies the configured
 * pass criteria. Mutates the result: status flips to 'passed' and
 * `autoPassed` records which criterion applied (except for a zero-count
 * diff — byte-different but nothing the diff engine flags — which is
 * simply passed). Diff images are kept either way.
 */
export function applyPassCriteria(result: SnapshotResult, criteria: PassCriteria): void {
  const {
    maxDiffPercent = 0,
    maxDiffPixels,
    noiseAutoPass = false,
    noiseMaxDiffPercent = 1,
    shiftTolerance = 0,
  } = criteria;

  // A page whose dimensions changed is never passed, whatever the pixel
  // counts say: content was added or removed, or the viewport differs. The
  // zero-count path below used to pass a grown page whose candidate had been
  // truncated to the baseline's height. A DOM change on its own never
  // decides the status: visible output is the contract, so the pixels do,
  // and the report says when a passed snapshot's DOM differs. Under
  // environmentPolicy "strict", a changed rendering environment is never
  // passed either.
  if (result.sizeMismatch || result.environment?.policy === 'strict') return;

  // Nothing above the per-pixel threshold: visually identical. Guard on
  // totalPixels — the PNG-decode-failure path reports diffCount 0 with
  // totalPixels 0 and must stay 'changed' for manual investigation.
  if (result.diffCount === 0 && result.totalPixels > 0) {
    result.status = 'passed';
    result.diffPercent = 0;
    return;
  }

  const withinPercent = result.diffPercent <= maxDiffPercent;
  const withinPixels = maxDiffPixels !== undefined && result.diffCount <= maxDiffPixels;
  if (withinPercent || withinPixels) {
    result.status = 'passed';
    result.autoPassed = 'threshold';
    return;
  }

  // Likely render noise: identical DOM AND computed styles compared and
  // equal. 'unavailable' (or a missing styleCheck from older results) means
  // a stylesheet-only change is not ruled out, so it stays for a human.
  // Render noise is also scattered: regions that all sit in one area are a
  // bad capture or a change the style check does not cover, so they stay
  // too. The size bound is noiseMaxDiffPercent, not diffShape's 1%.
  if (
    noiseAutoPass &&
    result.dom?.noiseHint === true &&
    result.dom.styleCheck === 'match' &&
    result.diffPercent <= noiseMaxDiffPercent &&
    diffShape(result).kind !== 'concentrated'
  ) {
    result.status = 'passed';
    result.autoPassed = 'noise';
    return;
  }

  // Layout tolerance: every region must be a verified pure shift within
  // the per-axis bound. Requires attribution (element maps) — regions
  // without a 'shift' classification are treated as real changes.
  if (shiftTolerance > 0 && result.regions && result.regions.length > 0) {
    const allSmallShifts = result.regions.every(
      (r) =>
        r.classification === 'shift' &&
        r.shift !== undefined &&
        Math.abs(r.shift.dx) <= shiftTolerance &&
        Math.abs(r.shift.dy) <= shiftTolerance,
    );
    if (allSmallShifts) {
      result.status = 'passed';
      result.autoPassed = 'shift';
    }
  }
}

/**
 * Run DOM diff and turn it into a report-shaped signal.
 *
 * Returns null when DOM data isn't available on either side — we don't
 * want to confuse the user with "DOM unchanged" hints when the adapter
 * never captured DOM in the first place.
 */
function computeDomSignal(
  baselineDom: string | null,
  candidateDom: string | null,
  volatileAttributes?: string[],
): SnapshotDomSignal | null {
  if (!baselineDom || !candidateDom) return null;
  const result = domDiff(baselineDom, candidateDom, { volatileAttributes });
  return {
    changed: result.domChanged,
    summary: result.summary,
    // Provisional: pixels differ, DOM does not. compareAll() clears this on
    // a style mismatch; with styleCheck 'unavailable' a stylesheet-only
    // change is not ruled out, so on its own this is not "likely noise".
    noiseHint: !result.domChanged,
  };
}

/**
 * Read a PNG's dimensions from its IHDR header without a full decode.
 * Returns null for anything that doesn't look like a PNG.
 */
function readPngDims(buffer: Buffer): { width: number; height: number } | null {
  // PNG signature (8 bytes) + IHDR length/type (8) → width at 16, height at 20
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452 /* 'IHDR' */) {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Decode a PNG buffer to raw RGBA pixel data using pngjs.
 */
function decodePng(buffer: Buffer): { data: Buffer; width: number; height: number } {
  const png = PNG.sync.read(buffer);
  return { data: png.data, width: png.width, height: png.height };
}

/**
 * Encode raw RGBA pixel data back to a PNG buffer.
 */
function encodePng(data: Buffer, width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data = data;
  return PNG.sync.write(png);
}

/**
 * Compare two PNG buffers.
 *
 * Decodes both PNGs to raw RGBA, runs the pixel-level diff engine,
 * writes a valid diff PNG, and returns a SnapshotResult.
 */
interface CompareMaskContext {
  configMasks: MaskSpec[];
  callMasks: MaskSpec[];
  capturedRects?: CapturedMaskRect[];
  regionOptions?: RegionOptions;
}

function compareBuffers(
  baselineBuffer: Buffer,
  candidateBuffer: Buffer,
  name: string,
  snapshotImagesDir: string,
  threshold: number,
  maskContext: CompareMaskContext = { configMasks: [], callMasks: [] },
): SnapshotResult {
  // Quick byte-level comparison — identical files need no decoding
  if (baselineBuffer.equals(candidateBuffer)) {
    const result: SnapshotResult = {
      name,
      status: 'passed',
      diffPercent: 0,
      diffCount: 0,
      totalPixels: 0,
      baselinePath: `images/${name}/baseline.png`,
      currentPath: `images/${name}/current.png`,
    };
    // Masks are moot for identical bytes, but the audit trail (and any
    // could-not-apply warnings) must still surface. Header-only dims read.
    const specCount = maskContext.configMasks.length + maskContext.callMasks.length;
    if (specCount > 0) {
      const dims = readPngDims(baselineBuffer);
      if (dims) {
        const fromConfig = resolveMasks(
          maskContext.configMasks, dims.width, dims.height, maskContext.capturedRects, 'config');
        const fromCall = resolveMasks(
          maskContext.callMasks, dims.width, dims.height, maskContext.capturedRects, 'call');
        const rects = [...fromConfig.rects, ...fromCall.rects];
        const warnings = [...fromConfig.warnings, ...fromCall.warnings];
        if (rects.length > 0) result.masks = rects;
        if (warnings.length > 0) result.maskWarnings = warnings;
      }
    }
    return result;
  }

  try {
    // Decode PNG → raw RGBA so the diff engine gets real pixel data
    const baseline = decodePng(baselineBuffer);
    const candidate = decodePng(candidateBuffer);

    // The diff canvas is the baseline's size or, when the dimensions differ,
    // max width × max height: the engine pads the smaller capture and counts
    // every padded pixel as changed. (Sizing the canvas to the baseline and
    // truncating the candidate passed a page that grew at 0%, and a width
    // change misaligned every row.)
    const sizeMismatch =
      baseline.width !== candidate.width || baseline.height !== candidate.height
        ? {
            baseline: { width: baseline.width, height: baseline.height },
            candidate: { width: candidate.width, height: candidate.height },
          }
        : undefined;
    const width = Math.max(baseline.width, candidate.width);
    const height = Math.max(baseline.height, candidate.height);

    // Copies, not views: pngjs may hand back a slice of a shared pool at an
    // unaligned offset, and the engine reads the pixels as Uint32.
    const baseline8 = new Uint8ClampedArray(baseline.data.length);
    baseline8.set(baseline.data);
    const candidate8 = new Uint8ClampedArray(candidate.data.length);
    candidate8.set(candidate.data);

    const diffOutput = new Uint8ClampedArray(width * height * 4);

    // Resolve masks against this image's dimensions. Config and per-call
    // specs are resolved separately so the audit trail records the origin.
    const fromConfig = resolveMasks(
      maskContext.configMasks, width, height, maskContext.capturedRects, 'config');
    const fromCall = resolveMasks(
      maskContext.callMasks, width, height, maskContext.capturedRects, 'call');
    const maskRects = [...fromConfig.rects, ...fromCall.rects];
    const maskWarnings = [...fromConfig.warnings, ...fromCall.warnings];

    const diffResult = diffEngine(baseline8, candidate8, diffOutput, baseline.width, baseline.height, {
      threshold,
      masks: maskRects,
      detectRegions: true,
      regionOptions: maskContext.regionOptions,
      ...(sizeMismatch ? { handleSizeMismatch: 'pad' as const, dimensions: sizeMismatch } : {}),
    });

    // Encode the diff RGBA back to a valid PNG and write it
    const diffPngBuffer = encodePng(Buffer.from(diffOutput.buffer), width, height);
    const diffPath = path.join(snapshotImagesDir, 'diff.png');
    fs.writeFileSync(diffPath, diffPngBuffer);

    // Status starts as 'changed'; applyPassCriteria() in compareAll may
    // flip it to 'passed' based on the configured tolerances.
    const status: SnapshotStatus = 'changed';

    const result: SnapshotResult = {
      name,
      status,
      diffPercent: diffResult.diffPercent,
      diffCount: diffResult.diffCount,
      totalPixels: diffResult.totalPixels,
      baselinePath: `images/${name}/baseline.png`,
      currentPath: `images/${name}/current.png`,
      diffPath: `images/${name}/diff.png`,
    };
    if (sizeMismatch) result.sizeMismatch = sizeMismatch;
    if (diffResult.regions) result.regions = diffResult.regions;
    if (maskRects.length > 0) result.masks = maskRects;
    if (maskWarnings.length > 0) result.maskWarnings = maskWarnings;
    return result;
  } catch (_err) {
    // PNG decode failed (corrupt file, unexpected format) — report as changed
    // without a diff image so the user can investigate manually
    return {
      name,
      status: 'changed',
      diffPercent: 100,
      diffCount: 0,
      totalPixels: 0,
      baselinePath: `images/${name}/baseline.png`,
      currentPath: `images/${name}/current.png`,
    };
  }
}
