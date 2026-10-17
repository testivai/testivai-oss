/**
 * Types for TestivAI GitHub Action
 *
 * Mirrors the shape of `results.json` produced by @testivai/witness'
 * generateReport(). Kept structurally compatible with older reports —
 * every field beyond {id?, name, status} is optional, so this Action
 * still parses results.json from earlier witness versions.
 *
 * Note: witness 1.x writes `diffPercent`; the Action accepts the older
 * `diffPercentage` spelling too for backward compatibility.
 */

export interface SnapshotDomSignal {
  /** True if the DOM differs structurally between baseline and candidate. */
  changed: boolean;
  /** Per-bucket counts; null when changed is false. */
  summary: { added: number; removed: number; attributeChanges: number; textChanges?: number } | null;
  /**
   * True when the pixels differ, the DOM is structurally unchanged and no
   * style mismatch was found. It does NOT by itself mean render noise: it is
   * likely noise (anti-aliasing, font hinting, sub-pixel layout) only when
   * `styleCheck` is 'match'. With 'unavailable' or no `styleCheck`, the
   * computed styles were not compared, so a stylesheet-only change is not
   * ruled out.
   */
  noiseHint: boolean;
  /**
   * witness 1.4+: computed-style digest comparison, baseline vs current.
   *   - 'match': style digests compared and equal; with an identical DOM,
   *     likely render noise (still not proof).
   *   - 'mismatch': styles changed; with an identical DOM, a REAL
   *     style-only change. witness then sets `noiseHint` to false.
   *   - 'unavailable': no comparable style digests on both sides (e.g. a
   *     capture without an element map), so styles were not compared.
   * Absent in results.json from older witness versions: treat as 'unavailable'.
   */
  styleCheck?: 'match' | 'mismatch' | 'unavailable';
  styleChanges?: { count: number; elements: string[] };
}

export interface SnapshotResult {
  /** Optional in newer witness versions where the snapshot name is the key. */
  id?: string;
  name: string;
  status: 'passed' | 'changed' | 'new';
  /** witness 1.x and later. */
  diffPercent?: number;
  /** Older witness versions. Action accepts either spelling. */
  diffPercentage?: number;
  baselinePath?: string;
  /** Optional in newer witness versions for 'new' snapshots. */
  currentPath?: string;
  diffPath?: string;
  /** Present when the adapter captured DOM alongside the screenshot. */
  dom?: SnapshotDomSignal;
  /** witness 1.5+: whole-page uniform displacement (injected-banner signature). */
  pageShift?: { dy: number; belowY: number; count: number };
  /** Pixels compared (the page area); with `regions`, says whether a diff is spread out or in one area. */
  totalPixels?: number;
  /** Changed-pixel clusters as bounding boxes. */
  regions?: Array<{ x: number; y: number; width: number; height: number }>;
  /**
   * witness schema 2.4.0+: the two sizes when the current capture's
   * dimensions differ from the baseline's. witness pads both to the larger
   * size and counts every padded pixel as changed, so the snapshot is never
   * passed and the pixel fields describe the padding.
   */
  sizeMismatch?: { baseline: { width: number; height: number }; candidate: { width: number; height: number } };
  /**
   * witness schema 2.5.0+: capture provenance, when the baseline and the
   * current capture both recorded their environment. `renderingDelta` lists
   * the changes that can affect rendering; with an identical DOM and matching
   * styles the diff is rendering drift (the machine changed, not the page).
   */
  environment?: {
    delta: string[];
    renderingDelta: string[];
    baseline?: import('../../packages/witness/src/capture/environment').CaptureEnvironment;
    candidate?: import('../../packages/witness/src/capture/environment').CaptureEnvironment;
    policy?: 'strict';
  };
}

export interface Summary {
  total: number;
  passed: number;
  changed: number;
  newSnapshots: number;
  /** witness schema 2.3.0+: baselines that received no capture this run. */
  missing?: number;
}

export interface ResultsData {
  timestamp: number;
  summary: Summary;
  snapshots: SnapshotResult[];
  /** witness schema 2.3.0+: names of baselines with no capture this run. */
  missingBaselines?: string[];
}

/**
 * One thing the AI triage judges: a changed or new snapshot, or a missing
 * baseline (in `missingBaselines`: committed, but no capture this run).
 */
export interface TriageItem {
  name: string;
  status: 'changed' | 'new' | 'missing';
}
