/**
 * TestivAI Report — Result types
 *
 * Machine-readable output for the GitHub Action and other consumers.
 */

export type SnapshotStatus = 'passed' | 'changed' | 'new';

export interface SnapshotDomSignal {
  /** True if the DOM differs structurally between baseline and candidate. */
  changed: boolean;
  /** Per-bucket counts; null when changed is false. */
  summary: { added: number; removed: number; attributeChanges: number; textChanges?: number } | null;
  /**
   * Noise hint: pixel diff is non-zero, the DOM is structurally unchanged,
   * and no computed-style mismatch was found. Read it together with
   * `styleCheck` and the shape of the diff: only with 'match' AND a small,
   * scattered diff (diffShape in report/diff-shape.ts, read from
   * `diffPercent`, `totalPixels` and `regions`) does it suggest render noise
   * (anti-aliasing, font hinting, sub-pixel layout), and even then it is not
   * proof. With 'match' but a diff concentrated in one area or large, it is a
   * bad capture or a change the style check does not cover. It is also true
   * when styleCheck is 'unavailable' (or missing, in older results): styles
   * were not compared, so a stylesheet-only change is not ruled out.
   */
  noiseHint: boolean;
  /**
   * Style-fingerprint verdict: 'match' (comparable digests equal — likely
   * render noise when the diff is small and scattered, still not proof; the
   * digest covers a fixed list of properties, not size, overflow, position,
   * transform and the like), 'mismatch' (styles changed with
   * identical DOM — a REAL change; the noise hint is suppressed),
   * 'unavailable' (no element map on one or both sides, or no element with
   * a style digest on both sides — styles were not compared, so a
   * stylesheet-only change is not ruled out). Absent in results written
   * before the style check existed; treat that like 'unavailable'.
   */
  styleCheck?: 'match' | 'mismatch' | 'unavailable';
  /** Present on mismatch: how many elements changed styles, and which. */
  styleChanges?: { count: number; elements: string[] };
}

export interface SnapshotResult {
  name: string;
  status: SnapshotStatus;
  /** Diff percentage (0-100). 0 for passed/new. */
  diffPercent: number;
  /** Number of changed pixels */
  diffCount: number;
  /** Total pixels compared */
  totalPixels: number;
  /** Relative path to baseline image (if any) */
  baselinePath?: string;
  /** Relative path to current (candidate) image */
  currentPath?: string;
  /** Relative path to diff image (if any) */
  diffPath?: string;
  /**
   * DOM-level signal. Present only when both baseline and candidate
   * captured DOM HTML alongside the screenshot.
   */
  dom?: SnapshotDomSignal;
  /**
   * Changed-pixel clusters as bounding boxes (top-left sorted). Present
   * for 'changed' results (and auto-passed ones — the boxes stay useful).
   */
  regions?: import('../diff/attribution').AttributedRegion[];
  /**
   * Masks applied to this comparison (resolved to pixels, with their
   * source) — the audit trail for excluded areas. Present when non-empty.
   */
  masks?: import('../diff/mask').MaskRect[];
  /** Mask specs that could not be applied (e.g. selector without captured geometry). */
  maskWarnings?: string[];
  /**
   * Whole-page uniform displacement (the injected-banner signature):
   * everything at or below `belowY` moved by `dy` px. Derived from the
   * element maps — present only when both captures carried one.
   */
  pageShift?: import('../diff/attribution').PageShift;
  /**
   * Present when the snapshot's pixels differed but a pass criterion
   * reported it as passed: 'threshold' (within maxDiffPercent /
   * maxDiffPixels), 'noise' (noiseAutoPass enabled, DOM identical AND
   * computed styles compared and identical — styleCheck 'match' — AND the
   * diff not concentrated in one area, within noiseMaxDiffPercent; a diff
   * whose styles were not compared or changed, or whose regions all sit in
   * one area, is never auto-passed as noise), or 'shift' (every region is a pure
   * element shift within shiftTolerance px). The diff image is still
   * written — auto-passes stay auditable.
   */
  autoPassed?: 'threshold' | 'noise' | 'shift';
  /**
   * ISO timestamp of when the compared baseline was last approved/added
   * (from the baseline's metadata.json). Provenance for reviewers: a
   * months-old baseline deserves a closer look than yesterday's.
   */
  baselineApprovedAt?: string;
  /**
   * Present when the candidate's dimensions differ from the baseline's
   * (schema 2.4.0). The two were padded to max width × max height before
   * diffing and every padded pixel counts as changed, so `totalPixels`,
   * `diffCount` and `regions` are on that canvas and a page that grew or
   * shrank is never passed by any criterion. A height change is content
   * added or removed (read it with `dom`); a width change is almost always
   * the viewport or device scale factor differing between the captures, not
   * the page (report/size-mismatch.ts words both).
   */
  sizeMismatch?: { baseline: { width: number; height: number }; candidate: { width: number; height: number } };
  /**
   * Capture provenance (schema 2.5.0): present when the baseline and the
   * current capture both recorded the environment they were captured in
   * (metadata.json `environment`). See report/environment.ts.
   */
  environment?: SnapshotEnvironment;
}

/** How the environment of the current capture differs from the baseline's. */
export interface SnapshotEnvironment {
  /** Every field that differs, as dotted paths ("browser.version"), sorted. Empty when nothing differs. */
  delta: string[];
  /**
   * The subset of `delta` that can change how the page renders: the
   * browser, the OS platform, distro and architecture (the OS release on
   * macOS and Windows), the render settings, the capture method, a
   * container and the environment label. Framework, adapter and driver
   * versions, the CI runner image and the project are context only.
   */
  renderingDelta: string[];
  /** The baseline's recorded environment. Present when `delta` is non-empty. */
  baseline?: import('../capture/environment').CaptureEnvironment;
  /** The current capture's recorded environment. Present when `delta` is non-empty. */
  candidate?: import('../capture/environment').CaptureEnvironment;
  /**
   * 'strict' when environmentPolicy "strict" made this snapshot changed
   * because its rendering environment changed, whatever its pixels say.
   */
  policy?: 'strict';
}

export interface ReportSummary {
  total: number;
  passed: number;
  changed: number;
  newSnapshots: number;
  /**
   * Baselines that received NO capture this run (baseline exists, nothing to
   * compare). Coverage-loss signal: a deleted/renamed test silently stops
   * guarding its page. Present (possibly 0) from schema 2.3.0.
   */
  missing?: number;
}

export interface ReportData {
  version: string;
  timestamp: string;
  summary: ReportSummary;
  snapshots: SnapshotResult[];
  /** Names of baselines with no capture this run (schema 2.3.0+). */
  missingBaselines?: string[];
  /**
   * The environment of this run's captures (schema 2.5.0): the fields every
   * capture that recorded one agrees on. Absent when none recorded one.
   */
  environment?: Partial<import('../capture/environment').CaptureEnvironment>;
}
