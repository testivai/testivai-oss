/**
 * The shape of a pixel diff whose DOM and computed styles both match.
 *
 * Render noise (anti-aliasing, font hinting) is small and scattered. A diff
 * whose regions all sit in one area is a bad capture or a change the style
 * check does not cover, and a large one is more than render noise changes.
 * The real cases come from fixtures/render-noise-shapes.results.json (see
 * fixtures/README.md for how each was made).
 */

import * as fs from 'fs';
import * as path from 'path';

import { collectElementMap } from '../capture/element-map';
import {
  CONCENTRATED_MAX_PAGE_SHARE,
  describeRegions,
  diffShape,
  NOISE_MAX_DIFF_PERCENT,
  STYLE_CHECK_DOES_NOT_COVER,
} from '../report/diff-shape';
import type { ReportData, SnapshotResult } from '../report/results';

const fixture: ReportData = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'render-noise-shapes.results.json'), 'utf8'),
);
const real = (name: string): SnapshotResult => {
  const s = fixture.snapshots.find((x) => x.name === name);
  if (!s) throw new Error(`no fixture snapshot ${name}`);
  return s;
};

describe('the fixture: every case has an identical DOM and matching styles', () => {
  it.each(fixture.snapshots.map((s) => [s.name, s]))('%s', (_name, s) => {
    expect(s.status).toBe('changed');
    expect(s.dom).toMatchObject({ changed: false, noiseHint: true, styleCheck: 'match' });
  });
});

describe('diffShape on real runs', () => {
  it.each([
    // Render noise: small and scattered.
    ['glyph-edge-noise', 'scattered'],
    ['font-subpixel-noise', 'scattered'],
    // The eval's real bug and bad captures: all in one area.
    ['card-clipped', 'concentrated'],
    ['card-text-not-painted', 'concentrated'],
    ['baseline-band-shifted', 'concentrated'],
    // A change the style check does not cover, on six cards of a one-screen page.
    ['titles-underlined', 'concentrated'],
    // Spread out, but more than render noise changes.
    ['font-subpixel-noise-over-1pct', 'large'],
    ['fonts-differ-between-machines', 'large'],
  ])('%s is %s', (name, kind) => {
    expect(diffShape(real(name)).kind).toBe(kind);
  });

  it('known limit: a class-wide change spread down a long page reads as scattered', () => {
    // Thirty underlined titles cover 40% of the page, as widely as the
    // text-rendering noise above (38%). Pinned so a change to the rule is a
    // deliberate one, not a surprise.
    const shape = diffShape(real('titles-underlined-long-page'));
    expect(shape.kind).toBe('scattered');
    expect(shape.pagePercent).toBeCloseTo(40.2, 1);
  });

  it('measures the box around every region of the clipped card', () => {
    const shape = diffShape(real('card-clipped'));
    expect(shape).toEqual({
      kind: 'concentrated',
      regionCount: 3,
      box: { x: 525, y: 387, width: 155, height: 52 },
      pagePercent: (155 * 52 * 100) / 1018880,
    });
  });

  it('has no box without regions', () => {
    expect(diffShape(real('glyph-edge-noise'))).toEqual({ kind: 'scattered', regionCount: 0, box: null, pagePercent: null });
  });
});

describe('diffShape rules', () => {
  const page = { totalPixels: 1000 * 1000 };
  const region = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it('small means at most NOISE_MAX_DIFF_PERCENT (1%, the noiseMaxDiffPercent default) of pixels', () => {
    expect(NOISE_MAX_DIFF_PERCENT).toBe(1);
    expect(diffShape({ ...page, diffPercent: 1 }).kind).toBe('scattered');
    expect(diffShape({ ...page, diffPercent: 1.01 }).kind).toBe('large');
  });

  it('an unknown diff size is not small', () => {
    expect(diffShape({ ...page }).kind).toBe('large');
  });

  it('concentrated means every region fits in a box covering at most a third of the page', () => {
    expect(CONCENTRATED_MAX_PAGE_SHARE).toBe(1 / 3);
    const wide = { totalPixels: 3000 * 1000 };
    // A 1000 x 1000 box on a 3000 x 1000 page: exactly a third, concentrated.
    expect(diffShape({ ...wide, diffPercent: 0.2, regions: [region(0, 0, 10, 10), region(990, 990, 10, 10)] }).kind).toBe(
      'concentrated',
    );
    // 1001 x 1000: just over a third, spread out.
    expect(diffShape({ ...wide, diffPercent: 0.2, regions: [region(0, 0, 10, 10), region(991, 990, 10, 10)] }).kind).toBe(
      'scattered',
    );
  });

  it('a concentrated diff is concentrated whatever its size', () => {
    expect(diffShape({ ...page, diffPercent: 5, regions: [region(0, 0, 200, 200)] }).kind).toBe('concentrated');
  });

  it('without a page size, regions cannot be shown to spread out: concentrated, with no page share', () => {
    expect(diffShape({ diffPercent: 0.2, regions: [region(10, 10, 20, 10)] })).toEqual({
      kind: 'concentrated',
      regionCount: 1,
      box: { x: 10, y: 10, width: 20, height: 10 },
      pagePercent: null,
    });
  });
});

describe('describeRegions', () => {
  it('names the regions, their box and its share of the page', () => {
    expect(describeRegions(diffShape(real('card-clipped')))).toBe('3 regions within 155×52 px, 0.8% of the page');
    expect(describeRegions(diffShape(real('card-text-not-painted')))).toBe('1 region within 211×53 px, 1.1% of the page');
  });

  it('leaves out the page share when the page size is unknown', () => {
    expect(describeRegions(diffShape({ diffPercent: 0.2, regions: [{ x: 1, y: 2, width: 20, height: 10 }] }))).toBe(
      '1 region within 20×10 px',
    );
  });

  it('says so when there are no regions', () => {
    expect(describeRegions(diffShape({ diffPercent: 0.2, totalPixels: 100 }))).toBe('no regions');
  });
});

describe('STYLE_CHECK_DOES_NOT_COVER', () => {
  // The verdicts name what the style digest leaves out; it must stay true of
  // the property list collectElementMap actually digests.
  const source = collectElementMap.toString();

  it('names what a real change the style check misses can be', () => {
    expect(STYLE_CHECK_DOES_NOT_COVER).toBe(
      'size, overflow, position, transform, text decoration, filters, pseudo-elements, or images and other assets',
    );
  });

  it.each(['width', 'height', 'max-height', 'overflow', 'position', 'top', 'transform', 'text-decoration-line', 'filter'])(
    'the style digest does not include %s',
    (prop) => {
      expect(source).not.toContain(`'${prop}'`);
    },
  );

  it.each(['color', 'background-color', 'font-size', 'padding-top', 'margin-top', 'display', 'opacity', 'box-shadow'])(
    'the style digest includes %s (so the list above is about the right function)',
    (prop) => {
      expect(source).toContain(`'${prop}'`);
    },
  );
});
