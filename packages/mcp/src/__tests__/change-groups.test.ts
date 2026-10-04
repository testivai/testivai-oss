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

  it('splits noise by whether the styles were compared', () => {
    expect(
      members([noise('a', 'match'), noise('b', 'match'), noise('c', 'unavailable'), noise('d', undefined)]),
    ).toEqual([
      ['noise', ['a', 'b']],
      ['noise', ['c', 'd']],
    ]);
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

  it('orders groups by size, then kind (style-only, page shift, noise), members by name, whatever the input order', () => {
    const input = [
      noise('n2', 'match'),
      styleOnly('s3', ['x']),
      shifted('p1', 8, 40),
      styleOnly('s1', ['x']),
      noise('n1', 'match'),
      styleOnly('s2', ['x']),
      shifted('p2', 8, 40),
    ];
    const expected = [
      ['style-only', ['s1', 's2', 's3']],
      ['page-shift', ['p1', 'p2']],
      ['noise', ['n1', 'n2']],
    ];
    for (const order of [input, [...input].reverse(), [input[3], input[0], input[6], input[1], input[5], input[2], input[4]]]) {
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
    expect(notCompared.label).toMatch(/styles not compared/i);
    expect(notCompared.label).not.toMatch(/styles both match/i);
  });
});

describe('changeGroupLines', () => {
  it('is empty when no group has two or more members', () => {
    expect(changeGroupLines([styleOnly('a', ['body > header']), structural('b')])).toEqual([]);
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

  it('with the synthetic pages: one token change still yields only that group (under-grouping, by design)', () => {
    // pricing, about and team each restyled a different set of elements, and
    // contact also changed structurally, so none of them can be grouped.
    expect(members(load('example-brand-synthetic-pages.results.json').snapshots)).toEqual([
      ['style-only', ['buttons', 'home', 'products']],
    ]);
  });
});
