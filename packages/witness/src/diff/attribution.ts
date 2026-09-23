/**
 * TestivAI Diff Engine — Element attribution + shift classification
 *
 * Adapters capture an element map alongside each screenshot
 * (`elements.json`: [{path, x, y, width, height, styleHash}], document
 * coordinates). Attribution intersects clustered diff regions with the
 * map to answer the reviewer's real question: WHICH element changed?
 *
 * Shift classification is layout-derived, not pixel math: an element
 * present in both maps with the same size and the same computed-style
 * digest but a different position is a pure translation — (dx, dy) is
 * exact. A moved element's diff region spans its old AND new position,
 * so region↔element matching scores against the union of the baseline
 * and candidate rects.
 *
 * Everything degrades gracefully: no maps → regions pass through
 * untouched (image-only inputs, older captures, adapters without
 * element-map support yet).
 */

import type { DiffRegion } from './types';

export interface ElementMapEntry {
  /** Deterministic CSS-ish path (tag.class:nth-of-type chain). */
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Digest of a normalized computed-style subset (adapter-generated). */
  styleHash: string;
}

export interface RegionElement {
  selector: string;
  role: 'shifted' | 'changed';
}

/** DiffRegion augmented with attribution (all fields additive/optional). */
export interface AttributedRegion extends DiffRegion {
  /** Elements this region maps to, smallest first (max 3). */
  elements?: RegionElement[];
  /** 'shift' = pure translation of the primary element; else 'change'. */
  classification?: 'shift' | 'change';
  /** Exact displacement when classification is 'shift'. */
  shift?: { dx: number; dy: number };
}

export interface PageShift {
  /** Uniform vertical displacement in px. */
  dy: number;
  /** Everything at or below this baseline y moved. */
  belowY: number;
  /** How many elements moved together. */
  count: number;
}

/** Parse an element map, dropping malformed entries. Never throws. */
export function parseElementMap(raw: unknown): ElementMapEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ElementMapEntry[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as ElementMapEntry).path === 'string' &&
      typeof (item as ElementMapEntry).x === 'number' &&
      typeof (item as ElementMapEntry).y === 'number' &&
      typeof (item as ElementMapEntry).width === 'number' &&
      typeof (item as ElementMapEntry).height === 'number'
    ) {
      const e = item as ElementMapEntry;
      out.push({
        path: e.path,
        x: e.x,
        y: e.y,
        width: e.width,
        height: e.height,
        styleHash: typeof e.styleHash === 'string' ? e.styleHash : '',
      });
    }
  }
  return out;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function containsPoint(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height;
}

/** Bounding box of two rects. */
function bbox(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

const MATCH_COVERAGE = 0.5;
const MAX_ELEMENTS_PER_REGION = 3;

/**
 * Attribute diff regions to elements and classify pure translations.
 *
 * Matching: a candidate element matches a region when the union of its
 * baseline and candidate rects covers ≥50% of the region, or contains
 * the region's center. The primary element is the smallest match; its
 * role decides the region's classification.
 */
export function attributeRegions(
  regions: DiffRegion[],
  baselineMap: ElementMapEntry[],
  candidateMap: ElementMapEntry[],
): AttributedRegion[] {
  if (baselineMap.length === 0 || candidateMap.length === 0) {
    return regions as AttributedRegion[];
  }

  const baselineByPath = new Map(baselineMap.map((e) => [e.path, e]));

  return regions.map((region) => {
    const cx = region.x + region.width / 2;
    const cy = region.y + region.height / 2;
    const regionArea = region.width * region.height;

    const matches = candidateMap
      .map((el) => {
        const b = baselineByPath.get(el.path);
        const span = b ? bbox(b, el) : el;
        const coverage = regionArea > 0 ? overlapArea(span, region) / regionArea : 0;
        return { el, baseline: b, coverage, center: containsPoint(span, cx, cy) };
      })
      .filter((m) => m.coverage >= MATCH_COVERAGE || m.center)
      .sort((a, b) => a.el.width * a.el.height - b.el.width * b.el.height)
      .slice(0, MAX_ELEMENTS_PER_REGION);

    if (matches.length === 0) return region as AttributedRegion;

    const roleOf = (m: (typeof matches)[number]): { role: RegionElement['role']; dx: number; dy: number } => {
      const b = m.baseline;
      if (
        b &&
        b.width === m.el.width &&
        b.height === m.el.height &&
        b.styleHash === m.el.styleHash &&
        (b.x !== m.el.x || b.y !== m.el.y)
      ) {
        return { role: 'shifted', dx: m.el.x - b.x, dy: m.el.y - b.y };
      }
      return { role: 'changed', dx: 0, dy: 0 };
    };

    const attributed: AttributedRegion = { ...region };
    attributed.elements = matches.map((m) => ({ selector: m.el.path, role: roleOf(m).role }));

    const primary = roleOf(matches[0]);
    if (primary.role === 'shifted') {
      attributed.classification = 'shift';
      attributed.shift = { dx: primary.dx, dy: primary.dy };
    } else {
      attributed.classification = 'change';
    }
    return attributed;
  });
}

export interface StyleComparison {
  status: 'match' | 'mismatch' | 'unavailable';
  /** Paths whose computed-style digest changed (mismatch only). */
  changed: string[];
}

/**
 * Compare computed-style digests between the two element maps.
 *
 * Only paths present on BOTH sides are compared — structural additions
 * and removals are the DOM diff's job, not the style fingerprint's.
 * Either side missing a map → 'unavailable' (the noise hint falls back
 * to its legacy DOM-only behavior, visibly labeled).
 *
 * A digest is only meaningful when BOTH sides actually carry one.
 * `parseElementMap` deliberately tolerates an absent `styleHash` (it
 * defaults to ''), because the Extension API asks adapters for bounds and
 * a path — not styles — so a map with no digests is a supported input, and
 * so is a hierarchy-derived map that has no computed styles to digest at all.
 * Comparing those empty strings would be a claim about evidence that was
 * never collected, in both directions:
 *
 *   - neither side has digests → every pair is ''==='' → a false 'match',
 *     which the report renders as "computed styles are identical";
 *   - one side has them and the other does not → every pair differs → a
 *     false 'mismatch' naming every shared element as style-changed.
 *
 * So pairs are only compared when both digests are non-empty, and a run
 * with no comparable pair is 'unavailable' rather than either verdict.
 */
export function compareStyleHashes(
  baselineMap: ElementMapEntry[],
  candidateMap: ElementMapEntry[],
): StyleComparison {
  if (baselineMap.length === 0 || candidateMap.length === 0) {
    return { status: 'unavailable', changed: [] };
  }
  const baselineByPath = new Map(baselineMap.map((e) => [e.path, e.styleHash]));
  const changed: string[] = [];
  let comparable = 0;
  for (const el of candidateMap) {
    const b = baselineByPath.get(el.path);
    if (b === undefined) continue;
    // An absent digest on either side is missing evidence, not a difference.
    if (b === '' || el.styleHash === '') continue;
    comparable++;
    if (b !== el.styleHash) changed.push(el.path);
  }
  if (comparable === 0) return { status: 'unavailable', changed: [] };
  return changed.length > 0 ? { status: 'mismatch', changed } : { status: 'match', changed: [] };
}

/**
 * Whole-page pass: detect "everything below y=N moved by dy" — the
 * classic injected-banner signature. Elements matched by path with
 * identical size and style digest are compared positionally; a dominant
 * group (≥80% of all vertically-moved elements, at least `minElements`)
 * sharing one exact dy with dx=0 is reported.
 */
export function detectPageShift(
  baselineMap: ElementMapEntry[],
  candidateMap: ElementMapEntry[],
  minElements = 3,
): PageShift | null {
  if (baselineMap.length === 0 || candidateMap.length === 0) return null;
  const baselineByPath = new Map(baselineMap.map((e) => [e.path, e]));

  const moved: Array<{ dy: number; baselineY: number }> = [];
  for (const el of candidateMap) {
    const b = baselineByPath.get(el.path);
    if (!b || b.width !== el.width || b.height !== el.height || b.styleHash !== el.styleHash) {
      continue;
    }
    const dx = el.x - b.x;
    const dy = el.y - b.y;
    if (dx === 0 && dy !== 0) moved.push({ dy, baselineY: b.y });
  }
  if (moved.length < minElements) return null;

  const groups = new Map<number, Array<{ dy: number; baselineY: number }>>();
  for (const m of moved) {
    const g = groups.get(m.dy) ?? [];
    g.push(m);
    groups.set(m.dy, g);
  }
  let best: Array<{ dy: number; baselineY: number }> = [];
  for (const g of groups.values()) if (g.length > best.length) best = g;

  if (best.length < minElements || best.length / moved.length < 0.8) return null;

  return {
    dy: best[0].dy,
    belowY: Math.min(...best.map((m) => m.baselineY)),
    count: best.length,
  };
}
