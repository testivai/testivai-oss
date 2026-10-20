import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import { BaselineStore, resolveBaselinesDir } from '@testivai/witness/baselines';
import { shellArg } from './tool-meta';
import {
  captureHealthReading,
  describeCaptureMethod,
  describeEnvironmentChange,
  describeRegions,
  describeSizeChange,
  diffShape,
  environmentChangeGroups,
  environmentChangeLine,
  explainHeightChange,
  formatSizes,
  isRenderingDrift,
  isUnhealthyCapture,
  NOISE_MAX_DIFF_PERCENT,
  sizeMismatchKind,
  snapshotEnvironmentChange,
  STYLE_CHECK_DOES_NOT_COVER,
  type CaptureEnvironment,
  type DiffShape,
  type SizeMismatchInfo,
  type SnapshotCaptureHealth,
} from '@testivai/witness/report';

/** Subset of the semver-governed results.json contract this server reads. */
export interface DomInfo {
  changed: boolean;
  noiseHint: boolean;
  summary: { added: number; removed: number; attributeChanges: number; textChanges?: number } | null;
  /** Style-fingerprint verdict: 'mismatch' = styles changed with identical DOM (a REAL change). */
  styleCheck?: 'match' | 'mismatch' | 'unavailable';
  styleChanges?: { count: number; elements: string[] };
}

export interface RegionInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  diffPercent?: number;
  /** Elements this region maps to, smallest first. */
  elements?: Array<{ selector: string; role: 'shifted' | 'changed' }>;
  /** 'shift' = pure translation of the primary element; else 'change'. */
  classification?: 'shift' | 'change';
  shift?: { dx: number; dy: number };
}

export interface SnapshotResult {
  name: string;
  status: 'passed' | 'changed' | 'new';
  diffPercent?: number;
  /** Pixels compared: the page area. With `regions`, it says whether a diff is spread out or in one area. */
  totalPixels?: number;
  baselinePath?: string;
  currentPath?: string;
  diffPath?: string;
  dom?: DomInfo;
  regions?: RegionInfo[];
  /** Whole-page uniform displacement — the injected-banner signature. */
  pageShift?: { dy: number; belowY: number; count: number };
  autoPassed?: 'threshold' | 'noise' | 'shift';
  maskWarnings?: string[];
  /**
   * results.json 2.4.0+: the two sizes when the candidate's dimensions differ
   * from the baseline's. witness pads both to max width × max height and
   * counts every padded pixel as changed, so the pixel layers describe the
   * padding and such a snapshot is never passed.
   */
  sizeMismatch?: SizeMismatchInfo;
  /**
   * results.json 2.5.0+: capture provenance, when the baseline and the
   * current capture both recorded their environment. `renderingDelta` lists
   * the changes that can affect rendering; with an identical DOM and matching
   * styles they make the diff rendering drift (the machine changed, not the
   * page). `policy: 'strict'` means environmentPolicy made it changed.
   */
  environment?: EnvironmentInfo;
  /**
   * results.json 2.7.0+: capture health, when the baseline or the current
   * capture recorded what failed to load. An unhealthy side (a web font or
   * stylesheet that failed) is never render noise: the verdict says
   * "unhealthy capture" before anything else.
   */
  captureHealth?: SnapshotCaptureHealth;
}

export interface EnvironmentInfo {
  delta: string[];
  renderingDelta: string[];
  baseline?: CaptureEnvironment;
  candidate?: CaptureEnvironment;
  policy?: 'strict';
}

export interface ResultsFile {
  version: string;
  timestamp: string;
  /** `missing`: results.json 2.3.0+, the number of baselines with no capture this run. */
  summary: { total: number; passed: number; changed: number; newSnapshots: number; missing?: number };
  snapshots: SnapshotResult[];
  /**
   * results.json 2.3.0+: committed baselines that got no capture this run
   * (the test was removed, renamed or skipped, or failed before it
   * captured). Absent in older results: treat as none.
   */
  missingBaselines?: string[];
}

export interface ProjectPaths {
  root: string;
  reportDir: string;
}

/** Resolve the report dir from .testivai/config.json (reportDir key), default visual-report/. */
export function resolvePaths(root: string): ProjectPaths {
  let reportDir = 'visual-report';
  const configPath = path.join(root, '.testivai', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof config.reportDir === 'string' && config.reportDir.length > 0) {
        reportDir = config.reportDir;
      }
    } catch {
      // unreadable config falls back to the default report dir
    }
  }
  return { root, reportDir: path.join(root, reportDir) };
}

export function readResults(paths: ProjectPaths): ResultsFile | null {
  const file = path.join(paths.reportDir, 'results.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ResultsFile;
}

/** The get_visual_results header: the run and its counts, with missing baselines when the results carry them. */
export function summaryLine(results: ResultsFile): string {
  const { total, passed, changed, newSnapshots, missing } = results.summary;
  const m = typeof missing === 'number' ? missing : Array.isArray(results.missingBaselines) ? results.missingBaselines.length : undefined;
  const missingText = m === undefined ? '' : `; ${m} missing baseline${m === 1 ? '' : 's'} (no capture this run)`;
  return `Run: ${results.timestamp} — ${total} snapshots: ${passed} passed, ${changed} changed, ${newSnapshots} new${missingText}.`;
}

/**
 * The missing baselines to report, in results order and each once: names in
 * `missingBaselines` that are not also a snapshot (the snapshot's own line
 * covers those). Older results have no such list: none.
 */
export function missingBaselineNames(results: ResultsFile): string[] {
  if (!Array.isArray(results.missingBaselines)) return [];
  const snapshots = new Set((results.snapshots ?? []).map((s) => s.name));
  const names = results.missingBaselines.filter((n): n is string => typeof n === 'string' && n.length > 0 && !snapshots.has(n));
  return [...new Set(names)];
}

/** A path for the reader: relative to the project root, with forward slashes. */
const projectPath = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/') || '.';

/** The baselines directory relative to the project root (config.json baselinesDir, `{platform}` resolved). */
export const baselinesDirFor = (root: string): string => projectPath(root, resolveBaselinesDir(root));

/** True when `target`, with every symlink resolved, is strictly inside `dir` (also resolved). */
function staysInside(dir: string, target: string): boolean {
  try {
    const realDir = fs.realpathSync(dir);
    return fs.realpathSync(target).startsWith(realDir + path.sep);
  } catch {
    return false;
  }
}

/**
 * The committed baseline directory of a missing baseline (absolute), or null.
 * This is the only way a missing name becomes a path: the name must be listed
 * in `missingBaselines` (and not be a snapshot), must name one directory
 * directly inside the baselines directory (resolveBaselinesDir: config.json
 * `baselinesDir`, `{platform}` included), and, when it exists, must not lead
 * out of it through a symlink. witness lists missing baselines from that
 * directory's own entries, so a real one always passes.
 */
export function missingBaselineDir(root: string, results: ResultsFile, name: string): string | null {
  if (name.includes('\0') || !missingBaselineNames(results).includes(name)) return null;
  const base = path.resolve(resolveBaselinesDir(root));
  const dir = path.resolve(base, name);
  if (path.dirname(dir) !== base || path.basename(dir) !== name) return null;
  if (fs.existsSync(dir) && !staysInside(base, dir)) return null;
  return dir;
}

/** One-line verdict for a missing baseline; `dir` is its baseline directory relative to the project root, when known. */
export function missingVerdict(dir?: string | null): string {
  return (
    "missing baseline — committed, but no capture this run: its test was removed, renamed or skipped, or failed before it captured (the report cannot say which; the test run's log can); " +
    `nothing to approve (approving only promotes a new capture) — to accept an intended removal, delete its baseline directory${dir ? ` (${dir})` : ''} in the same change`
  );
}

/**
 * Why a missing baseline's directory may not be there: the results predate a
 * deletion, or another machine wrote them with a baselinesDir that resolved
 * elsewhere (`{platform}`). Neither is "committed here", so no git rm.
 */
export function notHere(dir: string): string {
  return (
    `no baseline directory at ${dir} on this machine: the results may be stale (the baseline was already deleted, or the tests have not run since), ` +
    `or come from a machine whose baselinesDir resolved to another directory ({platform} resolves to ${process.platform} here); re-run the tests before judging it`
  );
}

/** A missing baseline's directory (absolute, and relative for the reader), whether it is there, and its verdict. */
function locateMissing(
  root: string,
  results: ResultsFile,
  name: string,
): { abs: string | null; dir: string | null; present: boolean; verdict: string } {
  const abs = missingBaselineDir(root, results, name);
  const dir = abs ? projectPath(root, abs) : null;
  const present = abs !== null && fs.existsSync(abs);
  return { abs, dir, present, verdict: abs && !present ? `missing baseline — ${notHere(dir as string)}` : missingVerdict(dir) };
}

/**
 * get_visual_results lines for the missing baselines. One is shaped like the
 * per-snapshot lines (`- <name>: <verdict>`). Several are grouped by kind,
 * each kind's verdict once and a short line per name, since a partial run
 * (`--grep`, a matrix lane) can leave most of the suite missing: committed
 * here, not on this machine (stale results, another platform's
 * `{platform}`), or a name outside the baselines directory. A baseline that
 * is not here is never under the "committed, delete it" verdict.
 */
export function missingBaselineLines(root: string, results: ResultsFile): string[] {
  const names = missingBaselineNames(results);
  if (names.length <= 1) return names.map((name) => `- ${name}: ${locateMissing(root, results, name).verdict}`);
  const committed: string[] = [];
  const notOnThisMachine: string[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    const { abs, present } = locateMissing(root, results, name);
    (!abs ? unresolved : present ? committed : notOnThisMachine).push(name);
  }
  const template = `${baselinesDirFor(root)}/<name>`;
  const group = (list: string[], header: string, verdict: string): string[] =>
    list.length > 0 ? [`${header} (${list.length}): ${verdict}`, ...list.map((n) => `- ${n}`)] : [];
  return [
    ...group(committed, 'Missing baselines', missingVerdict(template)),
    ...group(notOnThisMachine, 'Missing baselines not on this machine', `missing baseline — ${notHere(template)}`),
    ...group(
      unresolved,
      'Missing baselines whose name does not resolve to a directory inside the baselines directory',
      'no baseline files were read for them',
    ),
  ];
}

/** The files a committed baseline can hold, in the order they are listed. */
const BASELINE_FILES = ['screenshot.png', 'dom.html', 'metadata.json', 'elements.json'];


/** explain_snapshot for a missing baseline: no capture, so no layers; the committed files and what to check instead. */
export interface MissingBaselineExplanation {
  name: string;
  status: 'missing';
  verdict: string;
  baseline: {
    /** Relative to the project root; null when the name does not resolve inside the baselines directory. */
    directory: string | null;
    /** The committed files that exist (screenshot.png, dom.html, metadata.json, elements.json), relative to the project root. */
    files: string[];
  };
  guidance: string[];
}

function explainMissingBaseline(root: string, results: ResultsFile, name: string): MissingBaselineExplanation {
  const base = resolveBaselinesDir(root);
  const { abs, dir, present, verdict } = locateMissing(root, results, name);
  const files = abs
    ? BASELINE_FILES.map((f) => path.join(abs, f))
        .filter((f) => fs.existsSync(f) && staysInside(base, f))
        .map((f) => projectPath(root, f))
    : [];

  const guidance: string[] = [];
  if (!dir) {
    guidance.push(
      `The name "${name}" does not resolve to a directory inside the baselines directory (${projectPath(root, base)}), so no baseline files were read.`,
    );
  } else if (!present) {
    // Not committed here: stale results or another platform's baselinesDir.
    const why = notHere(dir);
    guidance.push(`${why.charAt(0).toUpperCase()}${why.slice(1)}.`);
  } else if (files.length === 0) {
    guidance.push(`No committed baseline files were found in ${dir}.`);
  }
  if (!dir || present) {
    guidance.push(
      `No capture this run: the baseline is committed${dir ? ` (${dir})` : ''}, but the test run captured nothing under this name, so there is no current image and nothing to diff. ` +
        'The report cannot say why: the test may have been removed or renamed, skipped, or failed before it captured. ' +
        "Check what the change under test did to that test or snapshot, and the test run's log for a failed or skipped test.",
    );
  }
  const fresh = results.snapshots.filter((s) => s.status === 'new').map((s) => s.name);
  if (fresh.length > 0) {
    const shown = fresh.slice(0, 10).join(', ') + (fresh.length > 10 ? ', …' : '');
    guidance.push(`New snapshots this run (no baseline yet): ${shown}. If one of them is this test under another name, it is a rename: judge the two together.`);
  }
  guidance.push(
    'Approving does nothing here: approve_snapshot and `testivai approve` only promote a new capture from .testivai/temp, and there is none.' +
      (!dir || present
        ? ` To accept an intended removal, delete the baseline directory in the same change${dir ? ` (git rm -r ${shellArg(dir)})` : ''}; otherwise restore the test, or what it needs to reach its capture.`
        : ''),
    'There is no capture to call bad, so this is not a glitch: an intended change if the change under test meant to remove or rename it, a bug if it did so by mistake or broke the test before its capture, otherwise a possible bug.',
  );
  return { name, status: 'missing', verdict, baseline: { directory: dir, files }, guidance };
}

/** One item of a tool result: text or a PNG. */
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** The longest edge of a full-page image get_diff sends; a larger one is downscaled to fit. */
export const MAX_IMAGE_EDGE = 1024;

/**
 * An image labelled like get_diff labels it, downscaled for model context.
 * Pass `decoded` when the caller has already read the PNG, to read it once.
 */
export function imageContent(label: string, raw: Buffer, decoded?: PNG): ToolContent[] {
  const downscaled = downscalePng(raw, MAX_IMAGE_EDGE, decoded);
  const wasDownscaled = downscaled.originalWidth !== downscaled.width || downscaled.originalHeight !== downscaled.height;
  return [
    { type: 'text', text: wasDownscaled ? `${label} (downscaled from ${downscaled.originalWidth}x${downscaled.originalHeight}):` : `${label}:` },
    { type: 'image', data: downscaled.data.toString('base64'), mimeType: 'image/png' },
  ];
}

/**
 * get_diff for a missing baseline: its verdict, that there is no current
 * capture, and the committed baseline screenshot only. A screenshot that is
 * not there, or not a PNG, is said, never thrown. Null when the name is not
 * a missing baseline.
 */
export function missingBaselineDiff(root: string, results: ResultsFile, name: string): ToolContent[] | null {
  if (!missingBaselineNames(results).includes(name)) return null;
  const { abs: dir, verdict } = locateMissing(root, results, name);
  const content: ToolContent[] = [
    { type: 'text', text: `${name}: ${verdict}` },
    {
      type: 'text',
      text: 'No current capture: nothing was captured under this name this run, so there is no current or diff image, only the committed baseline.',
    },
  ];
  if (!dir) {
    content.push({ type: 'text', text: `baseline: "${name}" does not resolve to a directory inside the baselines directory, so no file was read.` });
    return content;
  }
  const file = path.join(dir, 'screenshot.png');
  if (!fs.existsSync(file) || !staysInside(resolveBaselinesDir(root), file)) {
    content.push({ type: 'text', text: `baseline: no committed screenshot at ${projectPath(root, file)}.` });
    return content;
  }
  try {
    content.push(...imageContent('baseline', fs.readFileSync(file)));
  } catch (err) {
    content.push({
      type: 'text',
      text: `baseline: ${projectPath(root, file)} could not be read as a PNG (${err instanceof Error ? err.message : String(err)}).`,
    });
  }
  return content;
}

/**
 * Why the styles of an identical-DOM snapshot were not compared, or null when
 * they were. noiseHint means the DOM is identical and no style mismatch was
 * found, but only styleCheck 'match' proves the styles were compared:
 * 'unavailable' (no comparable digests on both sides) and results written
 * before the style check also carry the hint. Those are unknown, not noise:
 * a stylesheet-only change is not ruled out.
 */
function stylesNotCompared(dom: DomInfo | undefined): 'unavailable' | 'absent' | null {
  if (!dom?.noiseHint || dom.styleCheck === 'match') return null;
  return dom.styleCheck === undefined ? 'absent' : 'unavailable';
}

/** The parenthetical naming why the styles were not compared. */
const NOT_COMPARED_REASON: Record<'unavailable' | 'absent', string> = {
  unavailable: 'style check unavailable',
  absent: 'no style check in these results',
};

/**
 * The shape of an identical-DOM diff whose computed styles match, or null for
 * any other snapshot. Render noise is small and scattered; a diff
 * concentrated in one area or large is a bad capture or a change the style
 * check does not cover (see diffShape in @testivai/witness).
 */
function matchedStylesShape(snapshot: SnapshotResult): DiffShape | null {
  if (!snapshot.dom?.noiseHint || snapshot.dom.styleCheck !== 'match') return null;
  return diffShape(snapshot);
}

/**
 * The verdict for a snapshot whose dimensions changed. A height change is
 * read with the DOM signal and the page shift (explainHeightChange): the band
 * at the bottom is the new height, not where the change is, and an identical
 * DOM is the same content laid out differently, never content added. A width
 * change is almost always the viewport or the device scale factor, so it is
 * never described as a page change.
 */
function sizeChangeVerdict(snapshot: SnapshotResult): string {
  const sm = snapshot.sizeMismatch as SizeMismatchInfo;
  const change = `${describeSizeChange(sm)} (${formatSizes(sm)})`;
  if (sizeMismatchKind(sm) === 'width') {
    return (
      `${change}, so this is not a page change and the diff is on a padded canvas that does not describe the page; ` +
      "re-capture at the baseline's viewport and device scale, or re-baseline if the new size is intended"
    );
  }
  const s = snapshot.dom?.summary;
  const identical = Boolean(snapshot.dom && !snapshot.dom.changed);
  const dom = snapshot.dom?.changed ? ` and the DOM changed${s ? ` (${domSummaryDetail(s)})` : ''}` : identical ? ' with an identical DOM' : '';
  const reading = explainHeightChange(sm, { dom: snapshot.dom, pageShift: snapshot.pageShift });
  return `${change}${dom}: ${reading}; ${identical ? 'compare the images (get_diff) before approving' : 'confirm it is intended before approving'}`;
}

/** The DOM summary's counts: "4 added, 0 removed, 0 attribute changes, 2 text changes". */
function domSummaryDetail(s: NonNullable<DomInfo['summary']>): string {
  return `${s.added} added, ${s.removed} removed, ${s.attributeChanges} attribute changes${s.textChanges ? `, ${s.textChanges} text changes` : ''}`;
}

/**
 * One-line, agent-oriented verdict for a snapshot. The environment comes
 * first: environmentPolicy "strict", a size change from another capture
 * method and rendering drift (the DOM and computed styles match and the
 * rendering environment changed) each get their own verdict; any other
 * verdict gets the environment change as context.
 */
export function verdictFor(snapshot: SnapshotResult): string {
  const unhealthy = unhealthyVerdict(snapshot);
  if (unhealthy) return unhealthy;
  const base = pageVerdict(snapshot);
  if (snapshot.status === 'new') return base;
  const change = snapshotEnvironmentChange(snapshot);
  if (!change) return base;
  const pct = snapshot.diffPercent !== undefined ? `${snapshot.diffPercent.toFixed(2)}% pixels differ` : 'pixels differ';
  const env = snapshot.environment as EnvironmentInfo;
  if (snapshot.status === 'passed') {
    if (!snapshot.autoPassed) return `${base}, although the environment changed since the baseline (${change})`;
    if (isRenderingDrift(snapshot)) {
      return (
        `${base}; but this is rendering drift (${change} since the baseline): ` +
        're-baseline in this environment so the tolerance keeps measuring the page, not the machine'
      );
    }
    return `${base}; the environment also changed since the baseline (${change})`;
  }
  if (env.policy === 'strict') {
    return (
      `changed (${pct}) — environment changed (strict policy): ${change} since the baseline; ` +
      'environmentPolicy "strict" makes it changed whatever its pixels say, and approving re-baselines it in this environment'
    );
  }
  if (snapshot.sizeMismatch && env.baseline && env.candidate && env.renderingDelta.includes('adapter.captureMethod')) {
    return (
      `changed (${pct}) — capture method changed: ${describeCaptureMethod(env.baseline.adapter.captureMethod)} → ` +
      `${describeCaptureMethod(env.candidate.adapter.captureMethod)} since the baseline (${formatSizes(snapshot.sizeMismatch)}): ` +
      'the size change comes from how the screenshot was taken, not from the page; re-baseline with this capture method, or capture the way the baseline was'
    );
  }
  if (isRenderingDrift(snapshot)) {
    return (
      `changed (${pct}) — rendering drift: ${change} since the baseline, and the DOM and computed styles both match, ` +
      'so the environment changed, not the page; re-baseline once the images are confirmed to match apart from rendering (get_diff)'
    );
  }
  return `${base}; the environment also changed since the baseline (${change}), which can add rendering differences of its own`;
}

/**
 * The verdict for a snapshot with an unhealthy side (a web font or
 * stylesheet that failed to load), or null. It outranks every other reading:
 * the capture is not the page as built. Rendering drift, when also true, is
 * said after it.
 */
function unhealthyVerdict(snapshot: SnapshotResult): string | null {
  const reading = captureHealthReading(snapshot.captureHealth);
  if (!reading) return null;
  if (snapshot.status === 'new') return `new snapshot — unhealthy capture: ${reading.detail}; ${reading.next}`;
  const pct = snapshot.diffPercent !== undefined ? `${snapshot.diffPercent.toFixed(2)}% pixels differ` : 'pixels differ';
  if (snapshot.status === 'passed') {
    const who = reading.side === 'both' ? 'neither image shows' : reading.side === 'baseline' ? 'the baseline does not show' : 'the current capture does not show';
    // A tolerance passes an unhealthy capture only when both sides failed the same way.
    const how = snapshot.autoPassed ? `auto-passed by the '${snapshot.autoPassed}' criterion (${pct})` : 'no visual change';
    return `passed — ${how}, but ${who} the page as built (unhealthy capture: ${reading.detail}); ${reading.next}`;
  }
  let env = '';
  const change = snapshotEnvironmentChange(snapshot);
  if (change && isRenderingDrift(snapshot)) env = `; rendering drift too: ${change} since the baseline, with the DOM and computed styles matching`;
  else if (change) env = `; the environment also changed since the baseline (${change})`;
  return `changed (${pct}) — unhealthy capture: ${reading.detail}; ${reading.next}${env}`;
}

/**
 * get_visual_results' opening lines: one per environment change that two
 * or more changed snapshots share, with an honest count of the drift among
 * them (environmentChangeLine in @testivai/witness), then their names.
 */
export function environmentLines(snapshots: SnapshotResult[]): string[] {
  return environmentChangeGroups(snapshots)
    .filter((g) => g.snapshots.length >= 2)
    .map((g) => {
      const shown = g.snapshots.slice(0, 10).join(', ') + (g.snapshots.length > 10 ? ', …' : '');
      return `${environmentChangeLine(g)} Snapshots: ${shown}.`;
    });
}

/** The verdict from the page-side signals alone (pixels, DOM, styles, size). */
function pageVerdict(snapshot: SnapshotResult): string {
  const pct = snapshot.diffPercent !== undefined ? `${snapshot.diffPercent.toFixed(2)}% pixels differ` : 'pixels differ';
  const notCompared = stylesNotCompared(snapshot.dom);
  const shape = matchedStylesShape(snapshot);
  if (snapshot.status === 'passed') {
    // A DOM change never decides the status: the pixels do. A pass whose DOM
    // differs is information, with nothing to approve.
    const domChanged = snapshot.dom?.changed && snapshot.dom.summary ? domSummaryDetail(snapshot.dom.summary) : null;
    if (!snapshot.autoPassed) {
      return domChanged
        ? `passed — nothing visible changed, but the DOM differs (${domChanged}): hidden or off-screen content, or markup with no painted effect; nothing to approve`
        : 'passed — no visual change';
    }
    // An auto-pass is a configured tolerance: the pixel diff is still there.
    const verdict = `passed — auto-passed by the configured '${snapshot.autoPassed}' criterion: ${pct}, within its tolerance`;
    if (domChanged) {
      return `${verdict}; the DOM also changed (${domChanged}) — nothing to approve, but check the tolerance is meant to cover a markup change`;
    }
    if (snapshot.autoPassed === 'noise' && notCompared) {
      return `${verdict}; styles were not compared (${NOT_COMPARED_REASON[notCompared]}), so a stylesheet-only change is not ruled out — look at the diff`;
    }
    // A noise auto-pass from before noiseAutoPass refused concentrated diffs.
    if (snapshot.autoPassed === 'noise' && shape?.kind === 'concentrated') {
      return `${verdict}; but the diff is concentrated in one area (${describeRegions(shape)}), which render noise is not — look at the diff`;
    }
    return verdict;
  }
  if (snapshot.status === 'new') return 'new snapshot — no baseline yet; a human should review and approve it';
  // A size change outranks every other reading: the diff is on a padded
  // canvas, so shape, noise hint and style check describe the padding.
  if (snapshot.sizeMismatch) return `changed (${pct}) — ${sizeChangeVerdict(snapshot)}`;
  if (notCompared) {
    return (
      `changed (${pct}) but the DOM is structurally identical and styles were not compared (${NOT_COMPARED_REASON[notCompared]}) — ` +
      'could be render noise or a stylesheet-only change; look at the diff before approving'
    );
  }
  if (shape?.kind === 'concentrated') {
    return (
      `changed (${pct}) — the DOM and computed styles both match, but the diff is concentrated in one area (${describeRegions(shape)}): ` +
      `a bad capture, or a change the style check does not cover (${STYLE_CHECK_DOES_NOT_COVER}); compare the images (get_diff) before approving`
    );
  }
  if (shape?.kind === 'large') {
    return (
      `changed (${pct}) — the DOM and computed styles both match, but the diff is large (over ${NOISE_MAX_DIFF_PERCENT}% of pixels, spread across the page), ` +
      'more than render noise usually changes: often fonts or rendering that differ between machines, a bad capture, ' +
      'or a change the style check does not cover; compare the images (get_diff) before approving'
    );
  }
  if (snapshot.dom?.noiseHint) {
    return `changed (${pct}) but the DOM and computed styles both match and the diff is small and scattered — likely render noise (font hinting, anti-aliasing); mention it, don't block`;
  }
  if (snapshot.dom?.changed) {
    const s = snapshot.dom.summary;
    const detail = s ? ` (${domSummaryDetail(s)})` : '';
    return `changed (${pct}) and the DOM changed${detail} — a real structural change; confirm it is intended before approving`;
  }
  // Style-only change: the DOM is identical but computed styles differ. This is
  // a real change, not noise, and the HTML report has always said so — the
  // agent-facing verdict used to fall through to "no DOM data" here, which both
  // contradicted the report and hid the signal agents most need.
  if (snapshot.dom?.styleCheck === 'mismatch') {
    const n = snapshot.dom.styleChanges?.count ?? 0;
    const els = snapshot.dom.styleChanges?.elements?.slice(0, 3).join(', ');
    const detail = els ? ` (${els}${n > 3 ? ', …' : ''})` : '';
    return `changed (${pct}) — style-only change: ${n} element${n === 1 ? '' : 's'} restyled with identical DOM${detail}; a real change, not noise — confirm it is intended before approving`;
  }
  if (snapshot.dom) {
    const why =
      snapshot.dom.styleCheck === 'unavailable'
        ? ' and no element map was captured on both sides, so the style check could not run'
        : '';
    return `changed (${pct}) but the DOM is identical${why} — treat as needing human review`;
  }
  return `changed (${pct}) — no DOM data; treat as needing human review`;
}

/** Resolve a report-relative image path safely inside the report dir. */
/**
 * Explain why there is no `results.json`, using what IS on disk.
 *
 * "Run the visual tests first" is wrong and confusing on a sharded CI node:
 * the tests did run, but a shard captures without comparing, and the report is
 * produced by the job that merges every shard. Distinguishing those cases saves
 * an agent (or a human) from chasing a run that isn't broken.
 */
export function describeMissingResults(root: string): string {
  const paths = resolvePaths(root);
  const tempDir = path.join(paths.root, '.testivai', 'temp');
  const where = `${path.relative(paths.root, paths.reportDir) || paths.reportDir}/results.json`;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(tempDir, { withFileTypes: true });
  } catch {
    return (
      `No results found at ${where}, and no captures exist in .testivai/temp/. ` +
      'Run the visual tests first (e.g. npx playwright test).'
    );
  }

  const captures = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // A shard manifest is proof this machine deliberately captured without comparing.
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(tempDir, 'testivai-shard.json'), 'utf8'));
    const cur = raw?.shard?.current;
    const tot = raw?.shard?.total;
    if (typeof cur === 'number' && typeof tot === 'number') {
      return (
        `No results found at ${where} because this is capture-only shard ${cur}/${tot}. ` +
        `${captures.length} capture(s) are in .testivai/temp/, but no comparison ran here — ` +
        'a shard sees only its slice of the suite. The report is produced by the job that ' +
        'merges every shard: `testivai merge-captures <dirs...> && testivai report`.'
      );
    }
  } catch {
    // no manifest, or unreadable — fall through
  }

  if (captures.length > 0) {
    return (
      `No results found at ${where}, but ${captures.length} capture(s) exist in ` +
      '.testivai/temp/. The captures were never compared — run `npx testivai report` ' +
      '(this is also what capture-only mode expects, e.g. TESTIVAI_CAPTURE_ONLY=1).'
    );
  }

  return `No results found at ${where}. Run the visual tests first (e.g. npx playwright test).`;
}

/**
 * Absolute paths a person can open to see the images behind the verdicts:
 * the HTML report, each changed snapshot's diff image, and each new
 * snapshot's capture. Only files that exist inside the report dir are listed.
 */
export function reportLinks(paths: ProjectPaths, results: ResultsFile): string[] {
  const links: string[] = [];
  const report = resolveImage(paths, 'index.html');
  if (report) links.push(`- report: ${report}`);
  for (const s of results.snapshots) {
    const image =
      s.status === 'changed' && s.diffPath ? { label: 'diff', file: resolveImage(paths, s.diffPath) }
      : s.status === 'new' && s.currentPath ? { label: 'new capture', file: resolveImage(paths, s.currentPath) }
      : null;
    if (image?.file) links.push(`- ${s.name} (${image.label}): ${image.file}`);
  }
  return links.length > 0 ? ['Open on this machine:', ...links] : [];
}

export function resolveImage(paths: ProjectPaths, relativePath: string): string | null {
  const abs = path.resolve(paths.reportDir, relativePath);
  if (!abs.startsWith(path.resolve(paths.reportDir) + path.sep)) return null; // no traversal
  return fs.existsSync(abs) ? abs : null;
}

/**
 * Layered evidence bundle for one snapshot — the input a client LLM turns
 * into a human-quality narrative ("card #2 shifted +24px — likely the banner
 * injected above it"). Assembled entirely from signals already computed by
 * the local diff pipeline; the server ships evidence, the client's model is
 * the analysis layer.
 */
export interface SnapshotExplanation {
  name: string;
  status: 'passed' | 'changed' | 'new';
  verdict: string;
  layers: {
    /** Raw pixel evidence: how much changed and where. */
    pixel: {
      diffPercent: number | null;
      regionCount: number;
      /** Top regions by area, largest first (max 10). */
      regions: RegionInfo[];
      /**
       * How the diff is laid out (diffShape in @testivai/witness): 'scattered'
       * (small and spread out, the only shape render noise takes),
       * 'concentrated' (every region in one box covering at most a third of
       * the page) or 'large' (spread out, over 1% of pixels). Null for a new
       * snapshot or a pass with no pixel diff.
       */
      shape: DiffShape | null;
      /**
       * results.json 2.4.0+: the baseline's and the current capture's sizes
       * when they differ. The diff is then on a canvas of the larger size
       * with every padded pixel counted as changed, so the fields above
       * describe the padding. Null when the sizes match or are not recorded.
       */
      sizeMismatch: SizeMismatchInfo | null;
    };
    /** Element-level evidence: which elements, moved vs changed. */
    element: {
      pageShift: { dy: number; belowY: number; count: number } | null;
      shiftedSelectors: string[];
      changedSelectors: string[];
    };
    /** Structural evidence from the DOM pair. */
    dom: DomInfo | null;
    /**
     * Capture health (results.json 2.7.0+): what failed to load in each
     * capture, which side is unhealthy and why. Null when neither side
     * recorded health (not checked).
     */
    health: SnapshotCaptureHealth | null;
    /**
     * Capture provenance (results.json 2.5.0+): what changed in the capture
     * environment since the baseline. `change` words the rendering changes,
     * `context` the rest; `drift` is true when the diff is rendering drift.
     * Null when either side recorded no environment.
     */
    environment: {
      delta: string[];
      renderingDelta: string[];
      change: string | null;
      context: string | null;
      drift: boolean;
      policy: 'strict' | null;
      baseline: CaptureEnvironment | null;
      candidate: CaptureEnvironment | null;
    } | null;
  };
  /** Interpretation rules the evidence supports, phrased for the model. */
  guidance: string[];
}

/**
 * The smallest element every region maps to, or null when they share none.
 * Each region lists its elements smallest first, so the first shared one of
 * the first region is the smallest.
 */
function sharedElement(regions: RegionInfo[]): string | null {
  const [first, ...rest] = regions;
  if (!first) return null;
  const shared = (first.elements ?? [])
    .map((e) => e.selector)
    .filter((selector) => rest.every((r) => (r.elements ?? []).some((e) => e.selector === selector)));
  return shared[0] ?? null;
}

/**
 * Build the layered explanation bundle for one snapshot, the missing-baseline
 * explanation for a name in `missingBaselines` that is not a snapshot, or
 * null when the latest results have neither.
 */
export function explainSnapshot(root: string, name: string): SnapshotExplanation | MissingBaselineExplanation | null {
  const results = readResults(resolvePaths(root));
  if (!results) return null;
  const snapshot = results.snapshots.find((s) => s.name === name);
  if (!snapshot) return missingBaselineNames(results).includes(name) ? explainMissingBaseline(root, results, name) : null;

  const regions = [...(snapshot.regions ?? [])]
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, 10);

  const shifted = new Set<string>();
  const changed = new Set<string>();
  for (const r of snapshot.regions ?? []) {
    for (const el of r.elements ?? []) {
      (el.role === 'shifted' ? shifted : changed).add(el.selector);
    }
  }

  const guidance: string[] = [];
  // An unhealthy capture first: what it shows is not the page as built.
  const unhealthy = captureHealthReading(snapshot.captureHealth);
  if (unhealthy?.sameOnBothSides) {
    // The baseline failed the same way, so the failure is not the change under test.
    guidance.push(
      `Unhealthy capture, the same on both sides: ${unhealthy.detail}. ` +
        `Neither image shows the page as built, but both are missing the same assets, so the diff compares like with like: ${unhealthy.next}.`,
    );
  } else if (unhealthy) {
    guidance.push(
      `Unhealthy capture: ${unhealthy.detail}. The capture does not show the page as built, so this diff is not render noise and says nothing reliable about the page: ` +
        `${unhealthy.next}. If the change under test touched the asset that failed (moved, renamed or removed a font or stylesheet, or changed its path), it is a bug in that change.`,
    );
  }
  if (snapshot.status === 'new') {
    guidance.push('No baseline exists yet — this is a first capture, not a regression. A human should review and approve it.');
    // The other half of a rename: read on its own it would look like something to approve.
    const missing = missingBaselineNames(results);
    if (missing.length > 0) {
      const shown = missing.slice(0, 10).join(', ') + (missing.length > 10 ? ', …' : '');
      guidance.push(
        `Missing baselines this run (no capture): ${shown}. If this new snapshot is one of them under another name, it is a rename: judge the two together before approving it.`,
      );
    }
  }
  const notCompared = stylesNotCompared(snapshot.dom);
  const shape = matchedStylesShape(snapshot);
  // The DOM signal is computed before the pass criteria, so a passed snapshot
  // can still carry noiseHint. The noise / styles-not-compared reading is for
  // a diff pending review; a passed snapshot has nothing pending approval
  // (an auto-pass gets its own line below), so the verdict and guidance agree.
  const pending = snapshot.status === 'changed';
  // Capture provenance first: drift replaces the noise reading below.
  const envChange = snapshotEnvironmentChange(snapshot);
  const drift = isRenderingDrift(snapshot);
  if (snapshot.environment?.policy === 'strict' && envChange) {
    guidance.push(
      `environmentPolicy is "strict" and the environment changed since the baseline (${envChange}), so this snapshot is changed whatever its pixels say. ` +
        "Approving re-baselines it in this environment; otherwise capture it in the baseline's environment.",
    );
  }
  if (drift && envChange) {
    guidance.push(
      `Rendering drift: the environment changed since the baseline (${envChange}) and the DOM and computed styles match, so the machine changed, not the page. ` +
        'Compare the images (get_diff): if they match apart from rendering (glyph edges, font weight, subpixel layout), the baseline needs re-approving in this environment ' +
        'once the human agrees; if something else differs, it is not drift alone. Do not call it render noise.',
    );
  } else if (envChange && (pending || snapshot.autoPassed)) {
    guidance.push(`The environment also changed since the baseline (${envChange}), which can add rendering differences of its own: weigh it, but it does not explain a DOM or style change.`);
  }
  // A size change (the pixel layers describe the padding) or rendering drift
  // (the reading is the environment's) replaces the shape, noise and
  // styles-not-compared readings below.
  const pixelReadingReplaced = snapshot.sizeMismatch !== undefined || drift;
  if (snapshot.sizeMismatch) {
    const sm = snapshot.sizeMismatch;
    const sizes = `The current capture is ${sm.candidate.width}×${sm.candidate.height}, the baseline ${sm.baseline.width}×${sm.baseline.height}: ${describeSizeChange(sm)}.`;
    if (sizeMismatchKind(sm) === 'width') {
      guidance.push(
        `${sizes} The two were padded to the larger size and every padded pixel counts as changed, so diffPercent, the regions and the diff image describe the padding, not the page. ` +
          "This is not a page change: re-capture at the baseline's viewport and device scale, or re-baseline if the new size is intended.",
      );
    } else {
      // The band is the new height, not where the change is (explainHeightChange).
      const grew = sm.candidate.height > sm.baseline.height;
      const reading = explainHeightChange(sm, { dom: snapshot.dom, pageShift: snapshot.pageShift });
      guidance.push(
        `${sizes} The two were padded to the larger size, so diffPercent, the regions and the diff image describe the ${grew ? 'added' : 'missing'} band before anything else. ` +
          `${reading.charAt(0).toUpperCase()}${reading.slice(1)}.`,
      );
    }
  }
  if (pending && !pixelReadingReplaced && notCompared) {
    const why = notCompared === 'absent' ? 'these results have no style check' : 'no comparable style digests on both sides';
    guidance.push(
      'Styles not compared — could be render noise or a stylesheet-only change: pixels differ and the DOM is ' +
        `structurally identical, but computed styles were not compared (${why}), so a stylesheet-only change is ` +
        'not ruled out. Do not treat it as noise: compare the images (get_diff) before approving.',
    );
  } else if (pending && !pixelReadingReplaced && shape?.kind === 'concentrated' && shape.box) {
    const regionList = snapshot.regions ?? [];
    const element = sharedElement(regionList);
    const mapsTo = element ? `, and ${regionList.length === 1 ? 'the region' : 'every region'} maps to \`${element}\`` : '';
    guidance.push(
      'Diff concentrated in one area, which render noise does not do: pixels differ and the DOM is structurally ' +
        `identical with matching style digests, but ${describeRegions(shape)}, changed (box at x=${shape.box.x}, ` +
        `y=${shape.box.y})${mapsTo}. Render noise is small and scattered (anti-aliasing and font hinting at glyph edges), ` +
        'so this is a bad capture (a torn or partly blank render, a shifted band, a bad baseline) or a change the style ' +
        `check does not cover (${STYLE_CHECK_DOES_NOT_COVER}). Do not treat it as noise: compare the images (get_diff) before approving.`,
    );
  } else if (pending && !pixelReadingReplaced && shape?.kind === 'large') {
    // diffShape treats an unknown size as not small; say so rather than claim a share.
    const size =
      snapshot.diffPercent === undefined
        ? 'the share of pixels that differ is unknown'
        : `${snapshot.diffPercent.toFixed(2)}% of pixels differ (over ${NOISE_MAX_DIFF_PERCENT}%)`;
    guidance.push(
      'Large diff, more than render noise usually changes: pixels differ and the DOM is structurally identical with ' +
        `matching style digests, but ${size}, spread across the page. That is often fonts or rendering that differ between the ` +
        'machines that captured the baseline and the current image; it can also be a bad capture or a change the style ' +
        `check does not cover (${STYLE_CHECK_DOES_NOT_COVER}). Do not treat it as noise: compare the images (get_diff) before approving.`,
    );
  } else if (pending && !pixelReadingReplaced && snapshot.dom?.noiseHint) {
    guidance.push('Pixels differ but the DOM is structurally identical, style digests match, and the diff is small and scattered — likely render noise (anti-aliasing, font hinting). Mention it; do not block on it.');
  }
  if (snapshot.dom?.styleCheck === 'mismatch' && snapshot.dom.changed) {
    // A class or style attribute change: the DOM changed AND elements were
    // restyled. Never call the DOM identical here.
    const els = snapshot.dom.styleChanges?.elements?.slice(0, 5).join(', ');
    guidance.push(`Computed styles also changed on ${snapshot.dom.styleChanges?.count ?? 'some'} element(s)${els ? ` (${els})` : ''} along with the DOM change.`);
  } else if (snapshot.dom?.styleCheck === 'mismatch') {
    const els = snapshot.dom.styleChanges?.elements?.slice(0, 5).join(', ');
    guidance.push(`Computed styles changed on ${snapshot.dom.styleChanges?.count ?? 'some'} element(s)${els ? ` (${els})` : ''} while the DOM stayed identical — a stylesheet-only change. This is REAL, not noise.`);
  }
  if (snapshot.pageShift) {
    guidance.push(`Everything at or below y=${snapshot.pageShift.belowY} moved ${snapshot.pageShift.dy > 0 ? 'down' : 'up'} by ${Math.abs(snapshot.pageShift.dy)}px (${snapshot.pageShift.count} elements together) — the signature of content inserted or removed above that line. Look there for the root cause, not at the moved elements.`);
  }
  if (shifted.size > 0 && changed.size === 0 && !snapshot.pageShift) {
    guidance.push('All attributed regions are pure shifts (elements moved, content unchanged) — usually a layout/spacing change upstream, not a content change.');
  }
  if (snapshot.dom?.changed && snapshot.dom.summary) {
    const detail = domSummaryDetail(snapshot.dom.summary);
    if (pending) {
      guidance.push(`The DOM changed structurally (${detail}) — confirm the change is intended before approving.`);
    } else if (!snapshot.autoPassed) {
      // Passed with no pixel above the threshold: the DOM change is
      // information, not something to approve.
      guidance.push(
        `Nothing visible changed (no pixel above the threshold), but the DOM differs (${detail}): hidden or off-screen content, ` +
          'or markup with no painted effect. Nothing to approve; worth knowing if the change was meant to be visible.',
      );
    }
  }
  if (snapshot.autoPassed === 'noise' && notCompared) {
    // A noise auto-pass that did not require a style match (older results).
    guidance.push(
      "This diff auto-passed via the 'noise' criterion although its styles were not compared, so a " +
        'stylesheet-only change was not ruled out — compare the images (get_diff) before relying on it.',
    );
  } else if (snapshot.autoPassed === 'noise' && shape?.kind === 'concentrated') {
    // A noise auto-pass from before noiseAutoPass refused concentrated diffs.
    guidance.push(
      `This diff auto-passed via the 'noise' criterion although it is concentrated in one area (${describeRegions(shape)}), ` +
        'which render noise is not — compare the images (get_diff) before relying on it.',
    );
  } else if (snapshot.autoPassed) {
    guidance.push(`This diff auto-passed via the '${snapshot.autoPassed}' criterion — reported for transparency, no action needed.`);
    if (snapshot.dom?.changed && snapshot.dom.summary) {
      guidance.push(
        `The DOM also changed (${domSummaryDetail(snapshot.dom.summary)}) within that tolerance. Nothing to approve, but check the tolerance is meant to cover a markup change.`,
      );
    }
  }
  const warnings = snapshot.captureHealth?.warnings ?? [];
  if (warnings.length > 0) {
    guidance.push(
      `Capture warnings (they make no capture unhealthy on their own): ${warnings.join('; ')}. A broken image shows as a changed region where it sits: check whether it is where the diff is.`,
    );
  }
  if (snapshot.maskWarnings?.length) {
    guidance.push(`Mask warnings: ${snapshot.maskWarnings.join('; ')} — some configured masks could not be applied.`);
  }
  guidance.push('Baseline approval is a human decision: propose, do not auto-approve.');

  return {
    name: snapshot.name,
    status: snapshot.status,
    verdict: verdictFor(snapshot),
    layers: {
      pixel: {
        diffPercent: snapshot.diffPercent ?? null,
        regionCount: snapshot.regions?.length ?? 0,
        regions,
        shape: snapshot.status === 'changed' || snapshot.autoPassed ? diffShape(snapshot) : null,
        sizeMismatch: snapshot.sizeMismatch ?? null,
      },
      environment: snapshot.environment ? explainEnvironment(snapshot, envChange, drift) : null,
      element: {
        pageShift: snapshot.pageShift ?? null,
        shiftedSelectors: [...shifted].slice(0, 10),
        changedSelectors: [...changed].slice(0, 10),
      },
      dom: snapshot.dom ?? null,
      health: snapshot.captureHealth ?? null,
    },
    guidance,
  };
}

/** The environment layer of explain_snapshot. */
function explainEnvironment(snapshot: SnapshotResult, change: string | null, drift: boolean): NonNullable<SnapshotExplanation['layers']['environment']> {
  const env = snapshot.environment as EnvironmentInfo;
  const contextFields = env.delta.filter((f) => !env.renderingDelta.includes(f));
  return {
    delta: env.delta,
    renderingDelta: env.renderingDelta,
    change,
    context: env.baseline && env.candidate && contextFields.length > 0 ? describeEnvironmentChange(env.baseline, env.candidate, contextFields) : null,
    drift,
    policy: env.policy ?? null,
    baseline: env.baseline ?? null,
    candidate: env.candidate ?? null,
  };
}

/** Result of an approve operation — machine-readable for agents. */
export interface ApproveResult {
  approved: string[];
  failed: Array<{ name: string; error: string }>;
}

/**
 * Approve one snapshot: promote its current capture in `.testivai/temp/<name>/`
 * to the committed baseline. Reuses the same BaselineStore the CLI uses, so
 * semantics (and undo) match `testivai approve <name>` exactly.
 */
export function approveSnapshot(root: string, name: string): ApproveResult {
  const store = new BaselineStore(root);
  try {
    store.approve(name);
    return { approved: [name], failed: [] };
  } catch (e) {
    return { approved: [], failed: [{ name, error: e instanceof Error ? e.message : String(e) }] };
  }
}

/** Approve every pending snapshot under `.testivai/temp/` (like `approve --all`). */
export function approveAll(root: string): ApproveResult {
  const store = new BaselineStore(root);
  const approved: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const name of store.listTemp()) {
    try {
      store.approve(name);
      approved.push(name);
    } catch (e) {
      failed.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { approved, failed };
}

export function listBaselines(root: string): string[] {
  // Honor config.json baselinesDir (incl. the {platform} token) so this
  // agrees with the store's resolution — see witness resolveBaselinesDir.
  const dir: string = resolveBaselinesDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/**
 * Downscale a PNG buffer using integer-stride nearest-neighbour sampling.
 * When the longest edge is <= maxEdge the original buffer is returned unchanged.
 * `decoded` is the buffer already read with pngjs, when the caller has it.
 *
 * @returns The (possibly) resized PNG buffer, output dimensions, and original dimensions.
 */
export function downscalePng(
  buffer: Buffer,
  maxEdge = 1024,
  decoded?: PNG
): { data: Buffer; width: number; height: number; originalWidth: number; originalHeight: number } {
  const original = decoded ?? PNG.sync.read(buffer);
  const { width: ow, height: oh } = original;
  const longestEdge = Math.max(ow, oh);

  if (longestEdge <= maxEdge) {
    return { data: buffer, width: ow, height: oh, originalWidth: ow, originalHeight: oh };
  }

  const stride = Math.ceil(longestEdge / maxEdge);
  const w = Math.ceil(ow / stride);
  const h = Math.ceil(oh / stride);

  const out = new PNG({ width: w, height: h });

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const srcIdx = ((y * stride) * ow + (x * stride)) * 4;
      const dstIdx = (y * w + x) * 4;
      out.data[dstIdx] = original.data[srcIdx];
      out.data[dstIdx + 1] = original.data[srcIdx + 1];
      out.data[dstIdx + 2] = original.data[srcIdx + 2];
      out.data[dstIdx + 3] = original.data[srcIdx + 3];
    }
  }

  return { data: PNG.sync.write(out), width: w, height: h, originalWidth: ow, originalHeight: oh };
}

/**
 * Whether the approve tools should force a per-call permission prompt.
 * Precedence: --approval-prompt / --no-approval-prompt (last one wins), then
 * `mcpApprovalPrompt` from .testivai/config.json, then the default (true).
 */
export function resolveApprovalPrompt(argv: string[], configValue: boolean | undefined): boolean {
  for (let i = argv.length - 1; i >= 0; i--) {
    if (argv[i] === '--approval-prompt') return true;
    if (argv[i] === '--no-approval-prompt') return false;
  }
  return configValue ?? true;
}

/** Snapshots listed together because their grouping signal is identical. */
export interface ChangeGroup {
  /**
   * 'styles-not-compared' is an identical DOM whose styles were not compared:
   * unknown (render noise or a stylesheet-only change), never 'noise'.
   * 'large-diff' is an identical DOM with matching styles whose diff is
   * spread out but over 1% of pixels: more than render noise usually
   * changes, never 'noise'. A diff concentrated in one area is never grouped.
   */
  basis: 'style-only' | 'page-shift' | 'styles-not-compared' | 'drift' | 'large-diff' | 'noise';
  /** What every member has in common, phrased for the reader. */
  label: string;
  /** Snapshot names, sorted. Always two or more. */
  members: string[];
}

type Signature = { basis: ChangeGroup['basis']; key: string; label: string };

// Real changes, then unknowns, before likely noise when groups are the same size.
const BASIS_ORDER: ChangeGroup['basis'][] = ['style-only', 'page-shift', 'styles-not-compared', 'drift', 'large-diff', 'noise'];

/**
 * The one grouping signal a changed snapshot carries, or null when it must
 * not be grouped. Precedence: structural (never grouped) > style-only >
 * page shift > styles not compared > concentrated (never grouped) > large
 * diff > noise. Every rule errs towards null: under-grouping is acceptable,
 * over-grouping is a bug.
 */
function signatureOf(s: SnapshotResult): Signature | null {
  // Only changed snapshots; auto-passed ones are status 'passed'.
  if (s.status !== 'changed') return null;
  // An unhealthy capture (a font or stylesheet that failed) has its own
  // cause on its own page: never grouped.
  if (isUnhealthyCapture(s)) return null;
  // No DOM data means a structural change cannot be ruled out.
  if (!s.dom || s.dom.changed) return null;
  // A size change: every padded pixel counts as changed, so the signals
  // below describe the padding, not the page. Never grouped.
  if (s.sizeMismatch) return null;

  if (s.dom.styleCheck === 'mismatch') {
    const changes = s.dom.styleChanges;
    // witness lists at most 10 elements: beyond that the lists cannot be
    // compared exactly, so a truncated signature is never grouped.
    if (!changes || changes.elements.length === 0 || changes.count > changes.elements.length) return null;
    const elements = [...changes.elements].sort();
    const n = elements.length;
    const shown = elements.slice(0, 3).join(', ') + (n > 3 ? ', …' : '');
    return {
      basis: 'style-only',
      key: `style-only:${elements.join('|')}`,
      label:
        `style-only change that restyled the same ${n} element${n === 1 ? '' : 's'} with identical DOM (${shown}); ` +
        'grouped on which elements changed style, not on the new style values',
    };
  }

  if (s.pageShift) {
    const { dy, belowY } = s.pageShift;
    return {
      basis: 'page-shift',
      key: `page-shift:${dy}:${belowY}`,
      label:
        `the same page shift: everything at or below y=${belowY} moved ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px; ` +
        'grouped on the displacement, not on its cause',
    };
  }

  // Styles not compared is unknown, not noise: its own basis, so it is never
  // grouped or labelled with noise. Unavailable and absent style checks are
  // labelled differently, so they are keyed apart.
  const notCompared = stylesNotCompared(s.dom);
  if (notCompared) {
    return {
      basis: 'styles-not-compared',
      key: `styles-not-compared:${notCompared}`,
      label:
        `identical DOM, styles not compared (${NOT_COMPARED_REASON[notCompared]}): ` +
        'render noise or a stylesheet-only change, not ruled out',
    };
  }
  // Rendering drift: the environment changed, not the page. Keyed by the
  // change, so two different browser bumps are never one group, and never
  // grouped as noise.
  if (isRenderingDrift(s)) {
    const change = snapshotEnvironmentChange(s) as string;
    return {
      basis: 'drift',
      key: `drift:${change}`,
      label: `rendering drift: ${change} since the baseline, with the DOM and computed styles matching`,
    };
  }
  // Matching styles: likely noise only when the diff is small and scattered.
  // A diff concentrated in one area sits in its own place on its own page,
  // so grouping two would suggest one cause: never grouped, never as noise.
  const shape = matchedStylesShape(s);
  if (shape?.kind === 'concentrated') return null;
  if (shape?.kind === 'large') {
    return {
      basis: 'large-diff',
      key: 'large-diff',
      label:
        `identical DOM and computed styles, but over ${NOISE_MAX_DIFF_PERCENT}% of pixels differ, spread across the page: ` +
        'more than render noise usually changes; grouped on that signal, not on its cause',
    };
  }
  if (s.dom.noiseHint) {
    return {
      basis: 'noise',
      key: 'noise:match',
      label: 'likely render noise: the DOM and computed styles both match and the diff is small and scattered',
    };
  }
  return null;
}

/**
 * Deterministic grouping of changed snapshots whose grouping signal is
 * identical. Pure: no I/O, and the output does not depend on input order.
 * Groups are ordered by size (largest first), then kind (style-only, page
 * shift, styles not compared, large diff, noise), then signature; members by
 * name. Only groups with two or more members are returned.
 */
export function groupChanges(snapshots: SnapshotResult[]): ChangeGroup[] {
  const byKey = new Map<string, { signature: Signature; members: string[] }>();
  for (const s of snapshots) {
    const signature = signatureOf(s);
    if (!signature) continue;
    const entry = byKey.get(signature.key) ?? { signature, members: [] };
    entry.members.push(s.name);
    byKey.set(signature.key, entry);
  }
  return [...byKey.values()]
    .filter((g) => g.members.length >= 2)
    .sort(
      (a, b) =>
        b.members.length - a.members.length ||
        BASIS_ORDER.indexOf(a.signature.basis) - BASIS_ORDER.indexOf(b.signature.basis) ||
        (a.signature.key < b.signature.key ? -1 : a.signature.key > b.signature.key ? 1 : 0),
    )
    .map(({ signature, members }) => ({ basis: signature.basis, label: signature.label, members: [...members].sort() }));
}

/**
 * The get_visual_results section listing the groups, placed before the
 * per-snapshot lines (which stay unchanged). Empty when no group has two or
 * more members.
 */
export function changeGroupLines(snapshots: SnapshotResult[]): string[] {
  const groups = groupChanges(snapshots);
  if (groups.length === 0) return [];
  const truncated = snapshots
    .filter((s) => {
      const c = s.status === 'changed' && s.dom && !s.dom.changed && s.dom.styleCheck === 'mismatch' ? s.dom.styleChanges : undefined;
      return c !== undefined && c.count > c.elements.length;
    })
    .map((s) => s.name)
    .sort();
  return [
    'Grouped by identical signal (deterministic; members can still differ in ways the signal does not cover, so every snapshot keeps its own line below):',
    ...groups.map((g) => `- ${g.members.join(', ')} (${g.members.length}): ${g.label}`),
    ...(truncated.length > 0
      ? [
          `Not grouped: ${truncated.join(', ')} ${truncated.length === 1 ? 'has' : 'have'} more than 10 restyled elements, ` +
            'so the element lists are truncated and cannot be compared exactly.',
        ]
      : []),
  ];
}

/**
 * MCP makes a prompts/get request's `arguments` optional, but the SDK
 * validates a prompt's argument schema against the object itself and rejects
 * a request without one, even when every argument is optional. Run on each
 * incoming message, before the SDK sees it: a prompts/get with no arguments
 * gets an empty object. Everything else is returned as it was.
 */
export function withPromptArguments<T>(message: T): T {
  const m = message as { method?: unknown; params?: { arguments?: unknown } } | null;
  if (!m || typeof m !== 'object' || m.method !== 'prompts/get' || !m.params || m.params.arguments !== undefined) return message;
  return { ...m, params: { ...m.params, arguments: {} } } as T;
}
