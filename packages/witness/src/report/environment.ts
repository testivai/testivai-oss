/**
 * TestivAI Report — what changed in the capture environment
 *
 * The compare reads the environment the baseline was captured in next to the
 * current capture's (capture/environment.ts) and lists every field that
 * differs. Only some of those can change how a page renders. A new browser
 * build, another OS, distro or architecture, another device scale, viewport,
 * color scheme, locale or time zone, another capture method, a container or a
 * relabelled environment can; a newer test framework, adapter or driver, a
 * new CI runner image or another project name cannot on its own (a browser
 * that came with a framework upgrade shows up as the browser change).
 *
 * When pixels differ, the DOM and the computed styles are identical and the
 * rendering environment changed, the diff is RENDERING DRIFT: the machine
 * changed, not the page. The report, @testivai/mcp and the GitHub Action
 * word it that way instead of "likely render noise", and say it once at the
 * top when several snapshots share the same change.
 *
 * Read from results.json fields only, so every surface agrees.
 */

import type { CaptureEnvironment } from '../capture/environment';
import { type DiffShapeInput, diffShape } from './diff-shape';

/**
 * The fields of a snapshot result these rules read: results.json's own, so
 * @testivai/mcp and the GitHub Action pass their snapshot types as they are.
 */
export interface EnvironmentSnapshotInput extends DiffShapeInput {
  name: string;
  status: string;
  autoPassed?: string;
  dom?: { changed: boolean; styleCheck?: string } | null;
  sizeMismatch?: unknown;
  environment?: {
    delta: string[];
    renderingDelta: string[];
    baseline?: CaptureEnvironment;
    candidate?: CaptureEnvironment;
    policy?: string;
  } | null;
}

type Flat = Map<string, string>;

/** Fields whose absence means "no": the collector always decides them. */
const PRESENCE_DEFAULTS: Record<string, string> = { container: 'false', label: '', 'ci.provider': 'none' };

/** Fields that can change rendering on any platform. */
const RENDERING_FIELDS = new Set([
  'browser.name',
  'browser.version',
  'browser.channel',
  'browser.headless',
  'os.platform',
  'os.arch',
  'os.distro',
  'render.viewport',
  'render.deviceScaleFactor',
  'render.colorScheme',
  'render.reducedMotion',
  'render.locale',
  'render.timezone',
  'adapter.captureMethod',
  'container',
  'label',
]);

/** Platforms whose os.release is the OS version (and so the text renderer). */
const RELEASE_IS_OS_VERSION = new Set(['darwin', 'win32']);

function flatten(env: CaptureEnvironment): Flat {
  const flat: Flat = new Map();
  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    flat.set(key, String(value));
  };
  for (const [section, value] of Object.entries(env)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [field, inner] of Object.entries(value as Record<string, unknown>)) {
        if (section === 'render' && field === 'viewport' && inner && typeof inner === 'object') {
          const vp = inner as { width?: number; height?: number };
          put('render.viewport', `${vp.width}x${vp.height}`);
        } else if (inner === null || typeof inner !== 'object') {
          put(`${section}.${field}`, inner);
        }
      }
    } else {
      put(section, value);
    }
  }
  return flat;
}

/** Whether one differing field can change how the page renders. */
function isRenderingField(field: string, baseline: CaptureEnvironment, candidate: CaptureEnvironment): boolean {
  if (field.startsWith('render.')) return true;
  if (field === 'os.release') {
    return baseline.os.platform === candidate.os.platform && RELEASE_IS_OS_VERSION.has(candidate.os.platform);
  }
  return RENDERING_FIELDS.has(field);
}

/**
 * Every field that differs between two recorded environments, and the subset
 * that can change rendering, both sorted. A field recorded on one side only
 * is unknown (an older adapter did not record it), not a change; the
 * container, the label and the CI provider are always decided by the
 * collector, so their absence means "no".
 */
export function diffEnvironments(
  baseline: CaptureEnvironment,
  candidate: CaptureEnvironment,
): { delta: string[]; renderingDelta: string[] } {
  const a = flatten(baseline);
  const b = flatten(candidate);
  const keys = new Set([...a.keys(), ...b.keys(), ...Object.keys(PRESENCE_DEFAULTS)]);
  const delta: string[] = [];
  for (const key of keys) {
    const fallback = PRESENCE_DEFAULTS[key];
    const left = a.get(key) ?? fallback;
    const right = b.get(key) ?? fallback;
    if (left === undefined || right === undefined) continue;
    if (left !== right) delta.push(key);
  }
  delta.sort();
  return { delta, renderingDelta: delta.filter((f) => isRenderingField(f, baseline, candidate)) };
}

const MECHANISMS: Record<string, string> = {
  cdp: 'CDP',
  playwright: 'Playwright',
  stitched: 'scroll and stitch',
  firefox: 'Firefox',
  webdriver: 'WebDriver',
};

/** "full-page:cdp" → "full page (CDP)"; an unknown method passes through. */
export function describeCaptureMethod(method: string): string {
  const m = /^(full-page|viewport):([a-z0-9-]+)$/.exec(method);
  if (!m) return method;
  return `${m[1] === 'full-page' ? 'full page' : 'viewport'} (${MECHANISMS[m[2]] ?? m[2]})`;
}

/** The order changes are listed in: what renders first, context last. */
const ORDER = [
  'browser',
  'browser.channel',
  'browser.headless',
  'os.platform',
  'os.distro',
  'os.release',
  'os.arch',
  'render.viewport',
  'render.deviceScaleFactor',
  'render.colorScheme',
  'render.reducedMotion',
  'render.locale',
  'render.timezone',
  'adapter.captureMethod',
  'container',
  'label',
];

const LABELS: Record<string, string> = {
  'browser.channel': 'channel',
  'browser.headless': 'headless',
  'os.platform': 'OS',
  'os.release': 'OS release',
  'os.arch': 'arch',
  'render.viewport': 'viewport',
  'render.deviceScaleFactor': 'device scale',
  'render.colorScheme': 'color scheme',
  'render.reducedMotion': 'reduced motion',
  'render.locale': 'locale',
  'render.timezone': 'time zone',
  'ci.provider': 'CI',
  'ci.runnerImage': 'runner image',
  project: 'project',
};

const yesNo = (v: string | undefined) => (v === 'true' ? 'yes' : 'no');

/**
 * The listed fields as one readable clause, each with its values, in a fixed
 * order: "chromium 130.0.6723.58 → 141.0.7390.37, ubuntu 22.04 → ubuntu
 * 24.04, capture method full page (CDP) → viewport (WebDriver)".
 */
export function describeEnvironmentChange(
  baseline: CaptureEnvironment,
  candidate: CaptureEnvironment,
  fields: string[],
): string {
  const a = flatten(baseline);
  const b = flatten(candidate);
  const set = new Set(fields);
  const parts: Array<{ rank: number; text: string }> = [];
  const rank = (key: string) => {
    const i = ORDER.indexOf(key);
    return i === -1 ? ORDER.length : i;
  };

  if (set.has('browser.name') || set.has('browser.version')) {
    const side = (f: Flat, withName: boolean) =>
      [withName ? f.get('browser.name') : undefined, f.get('browser.version')].filter(Boolean).join(' ');
    const sameName = a.get('browser.name') === b.get('browser.name');
    parts.push({ rank: rank('browser'), text: `${side(a, true)} → ${side(b, !sameName)}` });
  }
  for (const field of set) {
    if (field === 'browser.name' || field === 'browser.version') continue;
    const left = a.get(field);
    const right = b.get(field);
    let text: string;
    if (field === 'browser.headless' || field === 'container') {
      text = `${field === 'container' ? 'container' : 'headless'} ${yesNo(left)} → ${yesNo(right)}`;
    } else if (field === 'label') {
      text = `environment label ${left || 'none'} → ${right || 'none'}`;
    } else if (field === 'os.distro') {
      text = `${left ?? 'unknown'} → ${right ?? 'unknown'}`;
    } else if (field === 'adapter.captureMethod') {
      text = `capture method ${describeCaptureMethod(left ?? '?')} → ${describeCaptureMethod(right ?? '?')}`;
    } else if (/^(framework|adapter|driver)\.version$/.test(field)) {
      const owner = field.split('.')[0];
      text = `${b.get(`${owner}.name`) ?? owner} ${left ?? '?'} → ${right ?? '?'}`;
    } else {
      text = `${LABELS[field] ?? field} ${left ?? 'none'} → ${right ?? 'none'}`;
    }
    parts.push({ rank: rank(field), text });
  }
  return parts
    .sort((x, y) => x.rank - y.rank)
    .map((p) => p.text)
    .join(', ');
}

/** Rendering fields that also explain a size change. */
const SIZE_FIELDS = ['render.viewport', 'render.deviceScaleFactor', 'adapter.captureMethod'];

/**
 * Rendering drift: pixels differ (the snapshot is changed, or was auto-passed
 * by a tolerance), the DOM is identical, the computed styles were compared and
 * match, and the rendering environment changed since the baseline. Never for
 * a diff concentrated in one area (a new browser or OS redraws text
 * everywhere; one area is a bad capture or a change the style check does not
 * cover). A size change counts only when the environment explains it (the
 * viewport, the device scale or the capture method changed).
 */
export function isRenderingDrift(snapshot: EnvironmentSnapshotInput): boolean {
  if (snapshot.status !== 'changed' && !(snapshot.status === 'passed' && snapshot.autoPassed)) return false;
  const rendering = snapshot.environment?.renderingDelta ?? [];
  if (rendering.length === 0) return false;
  const dom = snapshot.dom;
  if (!dom || dom.changed || dom.styleCheck !== 'match') return false;
  if (snapshot.sizeMismatch) return rendering.some((f) => SIZE_FIELDS.includes(f));
  return diffShape(snapshot).kind !== 'concentrated';
}

/** The rendering change of one snapshot, worded, or null when there is none. */
export function snapshotEnvironmentChange(snapshot: EnvironmentSnapshotInput): string | null {
  const e = snapshot.environment;
  if (!e || e.renderingDelta.length === 0 || !e.baseline || !e.candidate) return null;
  return describeEnvironmentChange(e.baseline, e.candidate, e.renderingDelta);
}

const SECTIONS_ORDER: Array<keyof CaptureEnvironment> = [
  'os',
  'browser',
  'framework',
  'adapter',
  'driver',
  'render',
  'ci',
  'container',
  'label',
  'project',
];

/**
 * The fields every listed environment agrees on: the run-level block in
 * results.json. One environment is its own; none is null.
 */
export function commonEnvironment(envs: CaptureEnvironment[]): Partial<CaptureEnvironment> | null {
  if (envs.length === 0) return null;
  const same = (values: unknown[]) => values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]));
  const out: Record<string, unknown> = {};
  for (const section of SECTIONS_ORDER) {
    const values = envs.map((e) => e[section]);
    if (values.every((v) => v === undefined)) continue;
    const first = values[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      if (values.some((v) => !v || typeof v !== 'object')) continue;
      const shared: Record<string, unknown> = {};
      for (const key of Object.keys(first)) {
        const inner = values.map((v) => (v as Record<string, unknown>)[key]);
        if (same(inner)) shared[key] = inner[0];
      }
      if (Object.keys(shared).length > 0) out[section] = shared;
    } else if (same(values)) {
      out[section] = first;
    }
  }
  return out as Partial<CaptureEnvironment>;
}

/** Snapshots sharing one rendering environment change. */
export interface EnvironmentChangeGroup {
  /** The change, worded (describeEnvironmentChange). */
  change: string;
  /** Changed or auto-passed snapshots with this change, in results order. */
  snapshots: string[];
  /** The subset that is rendering drift (isRenderingDrift). */
  drift: string[];
}

/**
 * Changed (and auto-passed) snapshots grouped by the same rendering
 * environment change, largest group first. A passed snapshot with no pixel
 * diff is not counted: nothing to explain.
 */
export function environmentChangeGroups(snapshots: EnvironmentSnapshotInput[]): EnvironmentChangeGroup[] {
  const groups = new Map<string, EnvironmentChangeGroup>();
  for (const s of snapshots) {
    if (s.status !== 'changed' && !(s.status === 'passed' && s.autoPassed)) continue;
    const change = snapshotEnvironmentChange(s);
    if (!change) continue;
    const group = groups.get(change) ?? { change, snapshots: [], drift: [] };
    group.snapshots.push(s.name);
    if (isRenderingDrift(s)) group.drift.push(s.name);
    groups.set(change, group);
  }
  return [...groups.values()].sort((x, y) => y.snapshots.length - x.snapshots.length);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The line said once at the top of the report, the PR comment and
 * get_visual_results for a group of two or more snapshots, with an honest
 * count of how many are drift alone.
 */
export function environmentChangeLine(group: EnvironmentChangeGroup): string {
  const n = group.snapshots.length;
  const d = group.drift.length;
  const head = `Environment changed since the baselines (${group.change})`;
  if (d === n) {
    return (
      `${head}: ${plural(n, 'diff is', 'diffs are')} rendering drift (DOM and computed styles identical), not page changes; ` +
      `re-baseline ${n === 1 ? 'it' : 'them'} once the images are confirmed.`
    );
  }
  if (d === 0) {
    return `${head} for ${plural(n, 'snapshot', 'snapshots')}; each also has a change the environment does not explain, so review ${n === 1 ? 'it' : 'them'} on ${n === 1 ? 'its' : 'their'} own.`;
  }
  const rest = n - d;
  return (
    `${head} for ${plural(n, 'snapshot', 'snapshots')}: ${d} ${d === 1 ? 'is' : 'are'} rendering drift (DOM and computed styles identical); ` +
    `${rest} also ${rest === 1 ? 'has' : 'have'} a change the environment does not explain, review ${rest === 1 ? 'it' : 'them'} on ${rest === 1 ? 'its' : 'their'} own.`
  );
}
