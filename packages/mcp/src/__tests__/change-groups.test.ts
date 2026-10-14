import * as fs from 'fs';
import * as path from 'path';
import { changeGroupLines, groupChanges, type ResultsFile, type SnapshotResult } from '../lib';

/**
 * Deterministic grouping for get_visual_results: snapshots whose grouping
 * signal is IDENTICAL are listed together. Under-grouping is acceptable;
 * over-grouping is a bug, so every rule here errs towards not grouping.
 */
const changed = (name: string, extra: Partial<SnapshotResult>): SnapshotResult => ({
  name,
  status: 'changed',
  diffPercent: 1,
  ...extra,
});
const styleOnly = (name: string, elements: string[], count = elements.length) =>
  changed(name, {
    dom: { changed: false, noiseHint: false, summary: null, styleCheck: 'mismatch', styleChanges: { count, elements } },
  });
const noise = (name: string, styleCheck: 'match' | 'unavailable' | undefined) =>
  changed(name, { dom: { changed: false, noiseHint: true, summary: null, styleCheck } });
const shifted = (name: string, dy: number, belowY: number) =>
  changed(name, { dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' }, pageShift: { dy, belowY, count: 4 } });
const structural = (name: string) =>
  changed(name, {
    dom: {
      changed: true,
      noiseHint: false,
      summary: { added: 1, removed: 0, attributeChanges: 0 },
      styleCheck: 'mismatch',
      styleChanges: { count: 1, elements: ['body > header'] },
    },
  });

const members = (snapshots: SnapshotResult[]) => groupChanges(snapshots).map((g) => [g.basis, g.members]);

describe('groupChanges', () => {
  it('groups style-only changes that restyled exactly the same elements, in any order', () => {
    const groups = groupChanges([
      styleOnly('b', ['body > header', 'body > main > .btn']),
      styleOnly('a', ['body > main > .btn', 'body > header']),
    ]);
    expect(groups.map((g) => [g.basis, g.members])).toEqual([['style-only', ['a', 'b']]]);
  });

  it('does not group style-only changes on different elements', () => {
    expect(groupChanges([styleOnly('a', ['body > header']), styleOnly('b', ['body > footer'])])).toEqual([]);
  });

  it('never groups truncated signatures, even when the visible part is identical', () => {
    const first10 = Array.from({ length: 10 }, (_, i) => `body > div:nth-of-type(${i + 1})`);
    expect(groupChanges([styleOnly('a', first10, 14), styleOnly('b', first10, 14)])).toEqual([]);
  });

  it('does not return single-member groups', () => {
    expect(groupChanges([styleOnly('a', ['body > header']), noise('b', 'match')])).toEqual([]);
  });

  it('excludes passed, new and auto-passed snapshots', () => {
    const autoPassed: SnapshotResult = { ...noise('auto', 'match'), status: 'passed', autoPassed: 'noise' };
    expect(
      members([
        noise('real', 'match'),
        autoPassed,
        { name: 'fresh', status: 'new' },
        { name: 'same', status: 'passed' },
      ]),
    ).toEqual([]);
  });

  it('never groups structural changes, even with identical style signatures', () => {
    expect(groupChanges([structural('a'), structural('b')])).toEqual([]);
  });

  it('does not group snapshots without DOM data (a structural change cannot be ruled out)', () => {
    const shift = { dy: 24, belowY: 120, count: 4 };
    expect(groupChanges([changed('a', { pageShift: shift }), changed('b', { pageShift: shift })])).toEqual([]);
  });

  it('groups page shifts only on identical dy and belowY', () => {
    expect(members([shifted('a', 24, 120), shifted('b', 24, 120), shifted('c', 24, 121), shifted('d', -24, 120)])).toEqual([
      ['page-shift', ['a', 'b']],
    ]);
  });

  // Only a compared style match makes identical-DOM diffs likely noise. When
  // the styles were not compared, a stylesheet-only change is not ruled out,
  // so those snapshots get their own basis and are never grouped (or
  // labelled) with noise. A style check that came back unavailable and
  // results with no style check at all are labelled differently, so they are
  // grouped apart.
  it('keeps identical-DOM diffs whose styles were not compared out of the noise group', () => {
    const groups = groupChanges([
      noise('a', 'match'),
      noise('b', 'match'),
      noise('c', 'unavailable'),
      noise('d', 'unavailable'),
      noise('e', undefined),
      noise('f', undefined),
    ]);
    expect(groups.map((g) => [g.basis, g.members])).toEqual([
      ['styles-not-compared', ['e', 'f']],
      ['styles-not-compared', ['c', 'd']],
      ['noise', ['a', 'b']],
    ]);
    expect(groups[0].label).toBe(
      'identical DOM, styles not compared (no style check in these results): render noise or a stylesheet-only change, not ruled out',
    );
    expect(groups.slice(0, 2).every((g) => !/likely render noise/i.test(g.label))).toBe(true);
  });

  // Identical DOM and matching styles is likely noise only when the diff is
  // small and scattered. A diff concentrated in one area sits in its own
  // place on its own page: grouping two of them would suggest one cause, so
  // they are never grouped, and never with noise.
  it('never groups diffs concentrated in one area, and keeps them out of the noise group', () => {
    const concentrated = (name: string) =>
      changed(name, {
        diffPercent: 0.03,
        totalPixels: 1000 * 1000,
        regions: [{ x: 10, y: 10, width: 100, height: 50 }],
        dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' },
      });
    expect(groupChanges([concentrated('a'), concentrated('b')])).toEqual([]);
    expect(members([concentrated('a'), concentrated('b'), noise('c', 'match'), noise('d', 'match')])).toEqual([
      ['noise', ['c', 'd']],
    ]);
  });

  // Spread out but over 1% of pixels: more than render noise usually
  // changes, often the same font or rendering difference between machines.
  // Its own basis, never noise.
  it('groups large spread-out diffs under their own basis, not with noise', () => {
    const large = (name: string) => changed(name, { diffPercent: 1.5, dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' } });
    const groups = groupChanges([large('a'), large('b'), noise('c', 'match'), noise('d', 'match')]);
    expect(groups.map((g) => [g.basis, g.members])).toEqual([
      ['large-diff', ['a', 'b']],
      ['noise', ['c', 'd']],
    ]);
    expect(groups[0].label).toBe(
      'identical DOM and computed styles, but over 1% of pixels differ, spread across the page: more than render noise usually changes; grouped on that signal, not on its cause',
    );
    expect(groups[0].label).not.toMatch(/likely render noise/i);
  });

  it('puts each snapshot in one group: style-only before page shift before noise', () => {
    const both = changed('both', {
      dom: { changed: false, noiseHint: false, summary: null, styleCheck: 'mismatch', styleChanges: { count: 1, elements: ['body > header'] } },
      pageShift: { dy: 24, belowY: 120, count: 4 },
    });
    expect(members([both, styleOnly('style', ['body > header']), shifted('shift', 24, 120)])).toEqual([
      ['style-only', ['both', 'style']],
    ]);
  });

  it('orders groups by size, then kind (style-only, page shift, styles not compared, large diff, noise), members by name, whatever the input order', () => {
    const large = (name: string) => changed(name, { diffPercent: 2, dom: { changed: false, noiseHint: true, summary: null, styleCheck: 'match' } });
    const input = [
      noise('n2', 'match'),
      styleOnly('s3', ['x']),
      noise('u2', 'unavailable'),
      large('l2'),
      shifted('p1', 8, 40),
      styleOnly('s1', ['x']),
      noise('n1', 'match'),
      noise('u1', 'unavailable'),
      large('l1'),
      styleOnly('s2', ['x']),
      shifted('p2', 8, 40),
    ];
    const expected = [
      ['style-only', ['s1', 's2', 's3']],
      ['page-shift', ['p1', 'p2']],
      ['styles-not-compared', ['u1', 'u2']],
      ['large-diff', ['l1', 'l2']],
      ['noise', ['n1', 'n2']],
    ];
    for (const order of [
      input,
      [...input].reverse(),
      [input[5], input[0], input[10], input[2], input[8], input[1], input[9], input[3], input[7], input[6], input[4]],
    ]) {
      expect(members(order)).toEqual(expected);
      expect(changeGroupLines(order)).toEqual(changeGroupLines(input));
    }
  });

  it('labels each group with exactly what it was based on', () => {
    const [style] = groupChanges([styleOnly('a', ['body > header']), styleOnly('b', ['body > header'])]);
    expect(style.label).toMatch(/same 1 element/);
    expect(style.label).toMatch(/not .*new style values/i);
    const [shift] = groupChanges([shifted('a', 24, 120), shifted('b', 24, 120)]);
    expect(shift.label).toMatch(/y=120 moved down 24px/);
    expect(shift.label).toMatch(/not .*cause/i);
    const [notCompared] = groupChanges([noise('a', 'unavailable'), noise('b', 'unavailable')]);
    expect(notCompared.basis).toBe('styles-not-compared');
    expect(notCompared.label).toBe(
      'identical DOM, styles not compared (style check unavailable): render noise or a stylesheet-only change, not ruled out',
    );
    expect(notCompared.label).not.toMatch(/likely render noise|styles both match/i);
    const [noiseGroup] = groupChanges([noise('a', 'match'), noise('b', 'match')]);
    expect(noiseGroup.basis).toBe('noise');
    expect(noiseGroup.label).toBe('likely render noise: the DOM and computed styles both match and the diff is small and scattered');
  });
});

describe('changeGroupLines', () => {
  it('is empty when no group has two or more members', () => {
    expect(changeGroupLines([styleOnly('a', ['body > header']), structural('b')])).toEqual([]);
  });

  it('prints the styles-not-compared group without calling it noise', () => {
    const lines = changeGroupLines([noise('a', 'unavailable'), noise('b', 'unavailable')]);
    expect(lines[1]).toBe(
      '- a, b (2): identical DOM, styles not compared (style check unavailable): render noise or a stylesheet-only change, not ruled out',
    );
    expect(lines.join('\n')).not.toMatch(/likely render noise/i);
  });

  it('heads the section, lists one line per group, and names truncated snapshots it could not group', () => {
    const first10 = Array.from({ length: 10 }, (_, i) => `body > div:nth-of-type(${i + 1})`);
    const lines = changeGroupLines([
      styleOnly('a', ['body > header']),
      styleOnly('b', ['body > header']),
      styleOnly('wide', first10, 14),
    ]);
    expect(lines[0]).toMatch(/^Grouped by identical signal/);
    expect(lines[0]).toMatch(/can still differ/);
    expect(lines[1]).toMatch(/^- a, b \(2\): /);
    expect(lines[2]).toMatch(/^Not grouped: wide /);
    expect(lines[2]).toMatch(/more than 10 restyled elements/);
    expect(lines).toHaveLength(3);
  });
});

describe('groupChanges on real results.json (see fixtures/README.md)', () => {
  const load = (file: string): ResultsFile =>
    JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'));

  it('example project, --brand changed: one group of the three identical captures', () => {
    expect(members(load('example-brand.results.json').snapshots)).toEqual([
      ['style-only', ['buttons', 'home', 'products']],
    ]);
  });

  // packages/witness/src/__tests__/fixtures/README.md: identical DOM and
  // matching styles throughout. The concentrated cases (the clipped card, the
  // bad capture, the bad baseline, the underlined titles) are never grouped;
  // the long-page underline is the rule's known blind spot and reads as noise.
  it('real runs with an identical DOM and matching styles: only scattered noise and large diffs are grouped', () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'witness', 'src', '__tests__', 'fixtures', 'render-noise-shapes.results.json'),
        'utf8',
      ),
    ) as ResultsFile;
    expect(members(fixture.snapshots)).toEqual([
      ['noise', ['font-subpixel-noise', 'glyph-edge-noise', 'titles-underlined-long-page']],
      ['large-diff', ['font-subpixel-noise-over-1pct', 'fonts-differ-between-machines']],
    ]);
  });

  it('with the synthetic pages: one token change still yields only that group (under-grouping, by design)', () => {
    // pricing, about and team each restyled a different set of elements, and
    // contact also changed structurally, so none of them can be grouped.
    expect(members(load('example-brand-synthetic-pages.results.json').snapshots)).toEqual([
      ['style-only', ['buttons', 'home', 'products']],
    ]);
  });
});
