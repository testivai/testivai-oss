import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import { BaselineStore } from '@testivai/witness/baselines';

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
  baselinePath?: string;
  currentPath?: string;
  diffPath?: string;
  dom?: DomInfo;
  regions?: RegionInfo[];
  /** Whole-page uniform displacement — the injected-banner signature. */
  pageShift?: { dy: number; belowY: number; count: number };
  autoPassed?: 'threshold' | 'noise' | 'shift';
  maskWarnings?: string[];
}

export interface ResultsFile {
  version: string;
  timestamp: string;
  summary: { total: number; passed: number; changed: number; newSnapshots: number };
  snapshots: SnapshotResult[];
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

/** One-line, agent-oriented verdict for a snapshot. */
export function verdictFor(snapshot: SnapshotResult): string {
  if (snapshot.status === 'passed') return 'passed — no visual change';
  if (snapshot.status === 'new') return 'new snapshot — no baseline yet; a human should review and approve it';
  const pct = snapshot.diffPercent !== undefined ? `${snapshot.diffPercent.toFixed(2)}% pixels differ` : 'pixels differ';
  // noiseHint means the DOM is identical and no style mismatch was found. Only
  // styleCheck 'match' proves the styles were compared; 'unavailable' (no
  // comparable digests) and results from before the style check also carry
  // the hint, so the verdict must not claim the styles matched there.
  if (snapshot.dom?.noiseHint) {
    const evidence =
      snapshot.dom.styleCheck === 'match'
        ? 'the DOM and computed styles both match'
        : 'DOM is structurally identical; styles were not compared (style check unavailable), so a style-only change is not ruled out';
    return `changed (${pct}) but ${evidence} — likely render noise (font hinting, anti-aliasing); mention it, don't block`;
  }
  if (snapshot.dom?.changed) {
    const s = snapshot.dom.summary;
    const detail = s
      ? ` (${s.added} added, ${s.removed} removed, ${s.attributeChanges} attribute changes${s.textChanges ? `, ${s.textChanges} text changes` : ''})`
      : '';
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
    };
    /** Element-level evidence: which elements, moved vs changed. */
    element: {
      pageShift: { dy: number; belowY: number; count: number } | null;
      shiftedSelectors: string[];
      changedSelectors: string[];
    };
    /** Structural evidence from the DOM pair. */
    dom: DomInfo | null;
  };
  /** Interpretation rules the evidence supports, phrased for the model. */
  guidance: string[];
}

/** Build the layered explanation bundle for one snapshot, or null if absent. */
export function explainSnapshot(root: string, name: string): SnapshotExplanation | null {
  const results = readResults(resolvePaths(root));
  const snapshot = results?.snapshots.find((s) => s.name === name);
  if (!results || !snapshot) return null;

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
  if (snapshot.status === 'new') {
    guidance.push('No baseline exists yet — this is a first capture, not a regression. A human should review and approve it.');
  }
  if (snapshot.dom?.noiseHint) {
    const evidence =
      snapshot.dom.styleCheck === 'match'
        ? 'the DOM is structurally identical and style digests match'
        : 'the DOM is structurally identical; styles were not compared (no comparable style digests), so a style-only change is not ruled out';
    guidance.push(`Pixels differ but ${evidence} — likely render noise (anti-aliasing, font hinting). Mention it; do not block on it.`);
  }
  if (snapshot.dom?.styleCheck === 'mismatch') {
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
    const s = snapshot.dom.summary;
    guidance.push(`The DOM changed structurally (${s.added} added, ${s.removed} removed, ${s.attributeChanges} attribute changes${s.textChanges ? `, ${s.textChanges} text changes` : ''}) — confirm the change is intended before approving.`);
  }
  if (snapshot.autoPassed) {
    guidance.push(`This diff auto-passed via the '${snapshot.autoPassed}' criterion — reported for transparency, no action needed.`);
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
      },
      element: {
        pageShift: snapshot.pageShift ?? null,
        shiftedSelectors: [...shifted].slice(0, 10),
        changedSelectors: [...changed].slice(0, 10),
      },
      dom: snapshot.dom ?? null,
    },
    guidance,
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
  const { resolveBaselinesDir } = require('@testivai/witness/baselines');
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
 *
 * @returns The (possibly) resized PNG buffer, output dimensions, and original dimensions.
 */
export function downscalePng(
  buffer: Buffer,
  maxEdge = 1024
): { data: Buffer; width: number; height: number; originalWidth: number; originalHeight: number } {
  const original = PNG.sync.read(buffer);
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
