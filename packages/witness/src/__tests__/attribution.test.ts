/**
 * Element attribution + shift classification — pure engine tests.
 *
 * The element map ([{path, x, y, width, height, styleHash}]) is captured
 * by adapters alongside the screenshot. Attribution intersects diff
 * regions with the map to name WHICH element changed; shift
 * classification compares an element's baseline vs candidate rects:
 * same path + same size + same styleHash but a different position is a
 * pure translation — exact (dx, dy) from layout, no pixel math.
 */

import {
  parseElementMap,
  attributeRegions,
  compareStyleHashes,
  detectPageShift,
  type ElementMapEntry,
} from '../diff/attribution';
import type { DiffRegion } from '../diff/types';

const el = (
  path: string,
  x: number,
  y: number,
  width: number,
  height: number,
  styleHash = 'aaaa1111',
): ElementMapEntry => ({ path, x, y, width, height, styleHash });

const region = (x: number, y: number, width: number, height: number): DiffRegion => ({
  x, y, width, height, diffPixels: width * height, diffPercent: 100,
});

describe('parseElementMap', () => {
  it('accepts a valid map and rejects garbage entries individually', () => {
    const parsed = parseElementMap([
      el('body > main', 0, 0, 100, 100),
      { path: 'broken' },              // missing rect
      { x: 1, y: 2, width: 3, height: 4 }, // missing path
      'junk',
      el('body > main > div.card', 10, 10, 50, 50),
    ]);
    expect(parsed).toHaveLength(2);
  });

  it('returns [] for non-arrays', () => {
    expect(parseElementMap(null)).toEqual([]);
    expect(parseElementMap({})).toEqual([]);
    expect(parseElementMap('x')).toEqual([]);
  });
});

describe('attributeRegions', () => {
  const baseline: ElementMapEntry[] = [
    el('body > main', 0, 0, 400, 400),
    el('body > main > section:nth-of-type(1)', 20, 20, 360, 100),
    el('body > main > section:nth-of-type(1) > div.card:nth-of-type(2)', 40, 40, 80, 60),
    el('body > main > section:nth-of-type(2)', 20, 200, 360, 100, 'bbbb2222'),
  ];

  it('names the smallest enclosing element for a region', () => {
    // Candidate identical to baseline; the region sits inside the card.
    const [r] = attributeRegions([region(50, 50, 30, 20)], baseline, baseline);
    expect(r.elements).toBeDefined();
    expect(r.elements![0].selector).toBe(
      'body > main > section:nth-of-type(1) > div.card:nth-of-type(2)',
    );
    // Same rect + same style + same position ⇒ content mutated inside it
    expect(r.elements![0].role).toBe('changed');
    expect(r.classification).toBe('change');
  });

  it('classifies a pure translation as shift with exact (dx, dy)', () => {
    const candidate = baseline.map((e) =>
      e.path.includes('div.card') ? { ...e, y: e.y + 8 } : e,
    );
    const [r] = attributeRegions([region(40, 40, 80, 68)], baseline, candidate);
    expect(r.classification).toBe('shift');
    expect(r.shift).toEqual({ dx: 0, dy: 8 });
    expect(r.elements![0].role).toBe('shifted');
  });

  it('a mutated element (styleHash differs) is never classified as shift', () => {
    const candidate = baseline.map((e) =>
      e.path.includes('div.card') ? { ...e, y: e.y + 8, styleHash: 'cccc3333' } : e,
    );
    const [r] = attributeRegions([region(40, 40, 80, 68)], baseline, candidate);
    expect(r.classification).toBe('change');
  });

  it('a resized element is never classified as shift', () => {
    const candidate = baseline.map((e) =>
      e.path.includes('div.card') ? { ...e, y: e.y + 8, width: e.width + 20 } : e,
    );
    const [r] = attributeRegions([region(40, 40, 100, 68)], baseline, candidate);
    expect(r.classification).toBe('change');
  });

  it('combined case: one shifted region, one mutated region — each classified correctly', () => {
    const candidate = baseline.map((e) =>
      e.path.includes('div.card') ? { ...e, x: e.x + 100 } : e,
    );
    const results = attributeRegions(
      [region(40, 40, 180, 60), region(30, 210, 100, 40)],
      baseline,
      candidate,
    );
    expect(results[0].classification).toBe('shift');
    expect(results[0].shift).toEqual({ dx: 100, dy: 0 });
    expect(results[1].classification).toBe('change'); // section 2 didn't move
  });

  it('missing maps leave regions untouched (image-only degradation)', () => {
    const regions = [region(10, 10, 20, 20)];
    const a = attributeRegions(regions, [], []);
    expect(a[0].elements).toBeUndefined();
    expect(a[0].classification).toBeUndefined();

    const b = attributeRegions(regions, baseline, []);
    expect(b[0].classification).toBeUndefined();
  });

  it('region matching nothing specific falls back to the nearest ancestor', () => {
    const [r] = attributeRegions([region(300, 350, 50, 30)], baseline, baseline);
    expect(r.elements![0].selector).toBe('body > main'); // only the root covers it
  });
});

describe('detectPageShift', () => {
  const mk = (n: number, y: number) =>
    el(`body > div:nth-of-type(${n})`, 0, y, 400, 40);

  it('reports a uniform vertical displacement below a cut line', () => {
    const baseline = [mk(1, 0), mk(2, 50), mk(3, 100), mk(4, 150), mk(5, 200), mk(6, 250), mk(7, 300)];
    // A banner appeared: everything from y=100 down moved +24px
    const candidate = baseline.map((e) => (e.y >= 100 ? { ...e, y: e.y + 24 } : e));

    const shift = detectPageShift(baseline, candidate, 3);
    expect(shift).toEqual({ dy: 24, belowY: 100, count: 5 });
  });

  it('returns null when displacements are not uniform or too few', () => {
    const baseline = [mk(1, 0), mk(2, 50), mk(3, 100)];
    const scattered = [mk(1, 0), { ...mk(2, 50), y: 60 }, { ...mk(3, 100), y: 90 }];
    expect(detectPageShift(baseline, scattered, 3)).toBeNull();

    const tooFew = baseline.map((e) => (e.y >= 100 ? { ...e, y: e.y + 24 } : e));
    expect(detectPageShift(baseline, tooFew, 3)).toBeNull(); // only 1 moved
  });

  it('returns null for identical maps', () => {
    const baseline = [mk(1, 0), mk(2, 50)];
    expect(detectPageShift(baseline, baseline, 2)).toBeNull();
  });
});

describe('compareStyleHashes', () => {
  const bounds = (path: string, styleHash: string): ElementMapEntry => ({
    path, x: 0, y: 0, width: 100, height: 20, styleHash,
  });

  it('reports match and mismatch when both sides carry digests', () => {
    const baseline = [bounds('body > h1', 'aaaa1111'), bounds('body > p', 'bbbb2222')];
    expect(compareStyleHashes(baseline, baseline)).toEqual({ status: 'match', changed: [] });

    const restyled = [bounds('body > h1', 'cccc3333'), bounds('body > p', 'bbbb2222')];
    expect(compareStyleHashes(baseline, restyled)).toEqual({
      status: 'mismatch',
      changed: ['body > h1'],
    });
  });

  it('is unavailable — not a match — when neither side carries a digest', () => {
    // A hierarchy-derived or bounds-only map (the Extension API asks adapters
    // for a path and a box, not styles). Comparing '' to '' would render in the
    // report as "computed styles are identical", which was never measured.
    const noDigests = [bounds('body > h1', ''), bounds('body > p', '')];
    expect(compareStyleHashes(noDigests, noDigests)).toEqual({
      status: 'unavailable',
      changed: [],
    });
  });

  it('is unavailable — not a mismatch — when only one side carries digests', () => {
    // An adapter that gains (or loses) style support against existing baselines.
    // Every shared path would otherwise be named as style-changed.
    const withDigests = [bounds('body > h1', 'aaaa1111'), bounds('body > p', 'bbbb2222')];
    const noDigests = [bounds('body > h1', ''), bounds('body > p', '')];

    expect(compareStyleHashes(noDigests, withDigests)).toEqual({
      status: 'unavailable',
      changed: [],
    });
    expect(compareStyleHashes(withDigests, noDigests)).toEqual({
      status: 'unavailable',
      changed: [],
    });
  });

  it('compares the pairs that do carry digests and ignores the rest', () => {
    const baseline = [bounds('body > h1', 'aaaa1111'), bounds('body > p', '')];
    const candidate = [bounds('body > h1', 'cccc3333'), bounds('body > p', 'dddd4444')];
    // body > p is uncomparable (empty on the baseline side), body > h1 changed.
    expect(compareStyleHashes(baseline, candidate)).toEqual({
      status: 'mismatch',
      changed: ['body > h1'],
    });
  });

  it('stays unavailable when either map is empty', () => {
    const map = [bounds('body > h1', 'aaaa1111')];
    expect(compareStyleHashes([], map)).toEqual({ status: 'unavailable', changed: [] });
    expect(compareStyleHashes(map, [])).toEqual({ status: 'unavailable', changed: [] });
  });
});
