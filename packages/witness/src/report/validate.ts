/**
 * Read a results.json you did not produce.
 *
 * A published report is rebuilt from results.json, and that file can come
 * from a CI run the reader does not control (a fork's pull request). The
 * template escapes every string it shows; it does not check that numbers
 * are numbers, that enums hold known values, or that the data has the
 * expected shape. This does, for every field the report reads:
 *
 * - each field must have its type (a finite number, text, a known value),
 *   within size limits, or the whole file is rejected with the field's path;
 * - fields it does not know are dropped, at every level;
 * - image paths (`baselinePath`, `currentPath`, `diffPath`, `thumbPath`) are
 *   never taken from the file: the caller adds them for the images it
 *   actually has. A `thumbPath` (schema 2.6.0) that is there must be text,
 *   or the file is rejected like for any other field.
 *
 * Its own module with no Node dependencies, so the GitHub Action can bundle
 * it without the rest of the report code.
 */

import type { CaptureEnvironment } from '../capture/environment';
import { type CaptureHealth, parseHealth } from '../capture/health';
import type { AttributedRegion, PageShift, RegionElement } from '../diff/attribution';
import type { MaskRect, MaskSource, MaskSpec } from '../diff/mask';
import type {
  ReportData,
  ReportSummary,
  SnapshotCaptureHealth,
  SnapshotDomSignal,
  SnapshotEnvironment,
  SnapshotResult,
  SnapshotStatus,
} from './results';

/** The results.json major version this reads: the major of RESULTS_SCHEMA_VERSION (generator.ts). */
export const SUPPORTED_SCHEMA_MAJOR = 2;

/** Size limits; a file over one is rejected. Far above what a real suite writes. */
export const REPORT_DATA_LIMITS = {
  snapshots: 5000,
  nameLength: 300,
  textLength: 2000,
  regions: 1000,
  elementsPerRegion: 10,
  styleElements: 200,
  masks: 500,
  maskWarnings: 200,
  maskSpecKeys: 50,
  missingBaselines: 5000,
  environmentKeys: 20,
  environmentValueLength: 200,
  environmentFields: 100,
  healthLines: 100,
} as const;

export type ParsedReportData = { ok: true; data: ReportData } | { ok: false; reason: string };

/**
 * Check a parsed results.json and return only the typed data the report
 * needs, or the reason it cannot be shown.
 */
export function parseReportData(json: unknown): ParsedReportData {
  try {
    return { ok: true, data: readReport(json) };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, reason: error.message };
    throw error;
  }
}

class Invalid extends Error {}

function fail(path: string, problem: string): never {
  throw new Invalid(`${path || 'results.json'}: ${problem}`);
}

function at(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'expected an object');
  return value;
}

function num(value: unknown, path: string, opts: { min?: number; whole?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  if (opts.min !== undefined && value < opts.min) fail(path, `expected at least ${opts.min}`);
  if (opts.whole && !Number.isInteger(value)) fail(path, 'expected a whole number');
  return value;
}

function count(value: unknown, path: string): number {
  return num(value, path, { min: 0, whole: true });
}

function text(value: unknown, path: string, max: number = REPORT_DATA_LIMITS.textLength, min = 0): string {
  if (typeof value !== 'string') fail(path, 'expected text');
  if (value.length < min) fail(path, 'expected non-empty text');
  if (value.length > max) fail(path, `longer than ${max} characters`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected true or false');
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(path, `expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function list<T>(value: unknown, path: string, max: number, item: (v: unknown, p: string) => T): T[] {
  if (!Array.isArray(value)) fail(path, 'expected a list');
  if (value.length > max) fail(path, `more than ${max} items`);
  return value.map((v, i) => item(v, `${path}[${i}]`));
}

/** Read `source[key]` when present; set it on `target` only when it is. */
function optional<T, K extends keyof T>(
  target: T,
  key: K,
  source: Record<string, unknown>,
  path: string,
  read: (v: unknown, p: string) => T[K],
): void {
  const value = source[key as string];
  if (value !== undefined) target[key] = read(value, at(path, key as string));
}

function readReport(json: unknown): ReportData {
  const root = record(json, '');
  const version = text(root.version, 'version', 32);
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) fail('version', 'expected a schema version like 2.4.0');
  const major = Number(match[1]);
  if (major > SUPPORTED_SCHEMA_MAJOR) {
    fail('version', `format ${version} is newer than this TestivAI can show (it reads ${SUPPORTED_SCHEMA_MAJOR}.x); open the report ZIP, or update TestivAI`);
  }
  if (major < SUPPORTED_SCHEMA_MAJOR) {
    fail('version', `format ${version} is older than this TestivAI can show (it reads ${SUPPORTED_SCHEMA_MAJOR}.x); open the report ZIP`);
  }

  const data: ReportData = {
    version,
    timestamp: text(root.timestamp, 'timestamp', 64),
    summary: readSummary(root.summary, 'summary'),
    snapshots: list(root.snapshots, 'snapshots', REPORT_DATA_LIMITS.snapshots, readSnapshot),
  };
  optional(data, 'missingBaselines', root, '', (v, p) =>
    list(v, p, REPORT_DATA_LIMITS.missingBaselines, (n, q) => text(n, q, REPORT_DATA_LIMITS.nameLength, 1)),
  );
  optional(data, 'environment', root, '', (v, p) => readEnvironmentBlock(v, p) as Partial<CaptureEnvironment>);
  return data;
}

function readSummary(value: unknown, path: string): ReportSummary {
  const s = record(value, path);
  const summary: ReportSummary = {
    total: count(s.total, at(path, 'total')),
    passed: count(s.passed, at(path, 'passed')),
    changed: count(s.changed, at(path, 'changed')),
    newSnapshots: count(s.newSnapshots, at(path, 'newSnapshots')),
  };
  optional(summary, 'missing', s, path, count);
  return summary;
}

const STATUSES: readonly SnapshotStatus[] = ['passed', 'changed', 'new'];

function readSnapshot(value: unknown, path: string): SnapshotResult {
  const s = record(value, path);
  const snapshot: SnapshotResult = {
    name: text(s.name, at(path, 'name'), REPORT_DATA_LIMITS.nameLength, 1),
    status: oneOf(s.status, at(path, 'status'), STATUSES),
    diffPercent: num(s.diffPercent, at(path, 'diffPercent'), { min: 0 }),
    diffCount: count(s.diffCount, at(path, 'diffCount')),
    totalPixels: count(s.totalPixels, at(path, 'totalPixels')),
  };
  optional(snapshot, 'dom', s, path, readDom);
  optional(snapshot, 'regions', s, path, (v, p) => list(v, p, REPORT_DATA_LIMITS.regions, readRegion));
  optional(snapshot, 'masks', s, path, (v, p) => list(v, p, REPORT_DATA_LIMITS.masks, readMask));
  optional(snapshot, 'maskWarnings', s, path, (v, p) => list(v, p, REPORT_DATA_LIMITS.maskWarnings, (w, q) => text(w, q)));
  optional(snapshot, 'pageShift', s, path, readPageShift);
  optional(snapshot, 'autoPassed', s, path, (v, p) => oneOf(v, p, ['threshold', 'noise', 'shift'] as const));
  optional(snapshot, 'baselineApprovedAt', s, path, (v, p) => text(v, p, 64));
  optional(snapshot, 'sizeMismatch', s, path, readSizeMismatch);
  optional(snapshot, 'environment', s, path, readSnapshotEnvironment);
  optional(snapshot, 'captureHealth', s, path, readCaptureHealth);
  // Checked, never kept: like the other image paths, the caller sets it for
  // a thumbnail it actually has (schema 2.6.0).
  if (s.thumbPath !== undefined) text(s.thumbPath, at(path, 'thumbPath'));
  return snapshot;
}

/** A snapshot's capture health (schema 2.7.0, sameOnBothSides 2.8.0); each recorded block goes through parseHealth. */
function readCaptureHealth(value: unknown, path: string): SnapshotCaptureHealth {
  const h = record(value, path);
  const block = (v: unknown, p: string): CaptureHealth => parseHealth(v) ?? fail(p, 'expected a capture health block');
  const lines = (v: unknown, p: string) => list(v, p, REPORT_DATA_LIMITS.healthLines, (l, q) => text(l, q));
  const unhealthyPath = at(path, 'unhealthy');
  const health: SnapshotCaptureHealth = {
    unhealthy: h.unhealthy === null ? null : oneOf(h.unhealthy, unhealthyPath, ['candidate', 'baseline', 'both'] as const),
    reasons: lines(h.reasons, at(path, 'reasons')),
    warnings: lines(h.warnings, at(path, 'warnings')),
  };
  optional(health, 'candidate', h, path, block);
  optional(health, 'baseline', h, path, block);
  // Schema 2.8.0: only ever true, and only when both sides are unhealthy.
  const samePath = at(path, 'sameOnBothSides');
  if (h.sameOnBothSides !== undefined) {
    if (h.sameOnBothSides !== true) fail(samePath, 'expected true when present');
    if (health.unhealthy !== 'both') fail(samePath, "only with unhealthy 'both'");
  }
  const { unhealthy, reasons, warnings } = health;
  return {
    ...(health.candidate ? { candidate: health.candidate } : {}),
    ...(health.baseline ? { baseline: health.baseline } : {}),
    unhealthy,
    ...(h.sameOnBothSides === true ? { sameOnBothSides: true as const } : {}),
    reasons,
    warnings,
  };
}

/** A snapshot's capture provenance (schema 2.5.0). */
function readSnapshotEnvironment(value: unknown, path: string): SnapshotEnvironment {
  const e = record(value, path);
  const fields = (v: unknown, p: string) => list(v, p, REPORT_DATA_LIMITS.environmentFields, (f, q) => text(f, q, 100, 1));
  const env: SnapshotEnvironment = {
    delta: fields(e.delta, at(path, 'delta')),
    renderingDelta: fields(e.renderingDelta, at(path, 'renderingDelta')),
  };
  optional(env, 'baseline', e, path, readCaptureEnvironment);
  optional(env, 'candidate', e, path, readCaptureEnvironment);
  optional(env, 'policy', e, path, (v, p) => oneOf(v, p, ['strict'] as const));
  return env;
}

/**
 * One capture's recorded environment: the fields the report reads directly
 * must be there (as readEnvironment in capture/environment.ts requires), and
 * the rest has the plain shape readEnvironmentBlock allows.
 */
function readCaptureEnvironment(value: unknown, path: string): CaptureEnvironment {
  const block = readEnvironmentBlock(value, path);
  const section = (name: string) => record(block[name], at(path, name));
  text(section('os').platform, at(path, 'os.platform'), REPORT_DATA_LIMITS.environmentValueLength, 1);
  text(section('browser').name, at(path, 'browser.name'), REPORT_DATA_LIMITS.environmentValueLength, 1);
  text(section('adapter').captureMethod, at(path, 'adapter.captureMethod'), REPORT_DATA_LIMITS.environmentValueLength, 1);
  return block as unknown as CaptureEnvironment;
}

const ENVIRONMENT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;

/**
 * An environment block as the report reads it (report/environment.ts
 * flattens it two levels deep): sections that are a plain value, or an
 * object of plain values; `render.viewport` is the one nested object
 * ({ width, height }). Plain values are short text, finite numbers, true or
 * false, or null. Fields it does not know are kept when they have this
 * shape, so a newer adapter's extra fields still show; anything deeper, a
 * list, or over the size limits is rejected.
 */
function readEnvironmentBlock(value: unknown, path: string): Record<string, unknown> {
  const plain = (v: unknown, p: string): string | number | boolean | null => {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return num(v, p);
    if (typeof v === 'string') return text(v, p, REPORT_DATA_LIMITS.environmentValueLength);
    fail(p, 'expected text, a number, true/false or null');
  };
  const keys = (o: Record<string, unknown>, p: string) => {
    const k = Object.keys(o);
    if (k.length > REPORT_DATA_LIMITS.environmentKeys) fail(p, `more than ${REPORT_DATA_LIMITS.environmentKeys} fields`);
    for (const key of k) if (!ENVIRONMENT_KEY.test(key)) fail(p, `field name ${JSON.stringify(key.slice(0, 50))} is not a plain name`);
    return k;
  };
  const block = record(value, path);
  const out: Record<string, unknown> = {};
  for (const sectionName of keys(block, path)) {
    const sectionPath = at(path, sectionName);
    const section = block[sectionName];
    if (!isRecord(section)) {
      out[sectionName] = plain(section, sectionPath);
      continue;
    }
    const inner: Record<string, unknown> = {};
    for (const field of keys(section, sectionPath)) {
      const fieldPath = at(sectionPath, field);
      const v = section[field];
      if (sectionName === 'render' && field === 'viewport') {
        const vp = record(v, fieldPath);
        inner[field] = { width: num(vp.width, at(fieldPath, 'width'), { min: 0 }), height: num(vp.height, at(fieldPath, 'height'), { min: 0 }) };
      } else {
        inner[field] = plain(v, fieldPath);
      }
    }
    out[sectionName] = inner;
  }
  return out;
}

function readDom(value: unknown, path: string): SnapshotDomSignal {
  const d = record(value, path);
  const dom: SnapshotDomSignal = {
    changed: bool(d.changed, at(path, 'changed')),
    noiseHint: bool(d.noiseHint, at(path, 'noiseHint')),
    summary: d.summary === undefined || d.summary === null ? null : readDomSummary(d.summary, at(path, 'summary')),
  };
  optional(dom, 'styleCheck', d, path, (v, p) => oneOf(v, p, ['match', 'mismatch', 'unavailable'] as const));
  optional(dom, 'styleChanges', d, path, (v, p) => {
    const c = record(v, p);
    return {
      count: count(c.count, at(p, 'count')),
      elements: list(c.elements, at(p, 'elements'), REPORT_DATA_LIMITS.styleElements, (e, q) => text(e, q)),
    };
  });
  return dom;
}

function readDomSummary(value: unknown, path: string): NonNullable<SnapshotDomSignal['summary']> {
  const s = record(value, path);
  const summary: NonNullable<SnapshotDomSignal['summary']> = {
    added: count(s.added, at(path, 'added')),
    removed: count(s.removed, at(path, 'removed')),
    attributeChanges: count(s.attributeChanges, at(path, 'attributeChanges')),
  };
  optional(summary, 'textChanges', s, path, count);
  return summary;
}

function readRegion(value: unknown, path: string): AttributedRegion {
  const r = record(value, path);
  const region: AttributedRegion = {
    x: num(r.x, at(path, 'x')),
    y: num(r.y, at(path, 'y')),
    width: num(r.width, at(path, 'width'), { min: 0 }),
    height: num(r.height, at(path, 'height'), { min: 0 }),
    diffPixels: num(r.diffPixels, at(path, 'diffPixels'), { min: 0 }),
    diffPercent: num(r.diffPercent, at(path, 'diffPercent'), { min: 0 }),
  };
  optional(region, 'classification', r, path, (v, p) => oneOf(v, p, ['shift', 'change'] as const));
  optional(region, 'shift', r, path, (v, p) => {
    const s = record(v, p);
    return { dx: num(s.dx, at(p, 'dx')), dy: num(s.dy, at(p, 'dy')) };
  });
  optional(region, 'elements', r, path, (v, p) =>
    list(v, p, REPORT_DATA_LIMITS.elementsPerRegion, (e, q): RegionElement => {
      const el = record(e, q);
      return { selector: text(el.selector, at(q, 'selector')), role: oneOf(el.role, at(q, 'role'), ['shifted', 'changed'] as const) };
    }),
  );
  return region;
}

function readMask(value: unknown, path: string): MaskRect {
  const m = record(value, path);
  const source = record(m.source, at(path, 'source'));
  const sourcePath = at(path, 'source');
  const mask: MaskRect = {
    x: num(m.x, at(path, 'x')),
    y: num(m.y, at(path, 'y')),
    width: num(m.width, at(path, 'width'), { min: 0 }),
    height: num(m.height, at(path, 'height'), { min: 0 }),
    source: {
      type: oneOf(source.type, at(sourcePath, 'type'), ['selector', 'region', 'edge'] as const),
      spec: readMaskSpec(source.spec, at(sourcePath, 'spec')),
      origin: oneOf(source.origin, at(sourcePath, 'origin'), ['config', 'call'] as const),
    } satisfies MaskSource,
  };
  return mask;
}

function readMaskSpec(value: unknown, path: string): MaskSpec {
  if (typeof value === 'string') return text(value, path);
  const spec = record(value, path);
  const keys = Object.keys(spec);
  if (keys.length > REPORT_DATA_LIMITS.maskSpecKeys) fail(path, `more than ${REPORT_DATA_LIMITS.maskSpecKeys} keys`);
  const out: Record<string, number | string> = {};
  for (const key of keys) {
    text(key, `${path} key`, 50, 1);
    const v = spec[key];
    out[key] = typeof v === 'number' ? num(v, at(path, key)) : text(v, at(path, key), 200);
  }
  return out;
}

function readPageShift(value: unknown, path: string): PageShift {
  const p = record(value, path);
  return { dy: num(p.dy, at(path, 'dy')), belowY: num(p.belowY, at(path, 'belowY')), count: count(p.count, at(path, 'count')) };
}

function readSizeMismatch(value: unknown, path: string): NonNullable<SnapshotResult['sizeMismatch']> {
  const s = record(value, path);
  const size = (v: unknown, p: string) => {
    const d = record(v, p);
    return { width: num(d.width, at(p, 'width'), { min: 1 }), height: num(d.height, at(p, 'height'), { min: 1 }) };
  };
  return { baseline: size(s.baseline, at(path, 'baseline')), candidate: size(s.candidate, at(path, 'candidate')) };
}
