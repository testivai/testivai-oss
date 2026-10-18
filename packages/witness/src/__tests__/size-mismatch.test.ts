/**
 * The shared wording for a capture whose dimensions differ from its
 * baseline (report/size-mismatch.ts), used by the HTML report, @testivai/mcp
 * and the GitHub Action so the three surfaces say the same thing.
 */
import { describeSizeChange, explainHeightChange, formatSizeMismatch, formatSizes, sizeMismatchKind } from '../report/size-mismatch';

const taller = { baseline: { width: 1280, height: 2348 }, candidate: { width: 1280, height: 2538 } };
const shorter = { baseline: { width: 1280, height: 2538 }, candidate: { width: 1280, height: 2348 } };
const wider = { baseline: { width: 1280, height: 800 }, candidate: { width: 1440, height: 800 } };
const both = { baseline: { width: 1280, height: 800 }, candidate: { width: 1440, height: 990 } };
const same = { baseline: { width: 1280, height: 800 }, candidate: { width: 1280, height: 800 } };

describe('sizeMismatchKind', () => {
  it('is height when only the height differs', () => {
    expect(sizeMismatchKind(taller)).toBe('height');
    expect(sizeMismatchKind(shorter)).toBe('height');
  });

  it('is width whenever the width differs, even with the height', () => {
    expect(sizeMismatchKind(wider)).toBe('width');
    expect(sizeMismatchKind(both)).toBe('width');
  });

  it('is null for equal dimensions', () => {
    expect(sizeMismatchKind(same)).toBeNull();
  });
});

describe('formatSizes', () => {
  it('reads baseline → current, with no delta', () => {
    expect(formatSizes(taller)).toBe('baseline 1280×2348 → current 1280×2538');
    expect(formatSizes(same)).toBe('baseline 1280×800 → current 1280×800');
  });
});

describe('formatSizeMismatch', () => {
  it('reads baseline → current with the pixel delta', () => {
    expect(formatSizeMismatch(taller)).toBe('baseline 1280×2348 → current 1280×2538 (+190 px)');
    expect(formatSizeMismatch(shorter)).toBe('baseline 1280×2538 → current 1280×2348 (-190 px)');
  });

  it('names the axis when the width changed', () => {
    expect(formatSizeMismatch(wider)).toBe('baseline 1280×800 → current 1440×800 (+160 px wide)');
    expect(formatSizeMismatch(both)).toBe('baseline 1280×800 → current 1440×990 (+160 px wide, +190 px tall)');
  });
});

describe('describeSizeChange', () => {
  it('a height change is the page growing or shrinking', () => {
    expect(describeSizeChange(taller)).toBe('page grew 190 px');
    expect(describeSizeChange(shorter)).toBe('page shrank 190 px');
  });

  // A width change is almost always the viewport or the device scale, not
  // the page: the wording says so instead of describing content.
  it('a width change points at the viewport or device scale, not the page', () => {
    expect(describeSizeChange(wider)).toBe('width changed 1280 → 1440: viewport or device scale differs');
    expect(describeSizeChange(both)).toBe('width changed 1280 → 1440 (and height 800 → 990): viewport or device scale differs');
    expect(describeSizeChange(wider)).not.toMatch(/page grew|page shrank/);
  });
});

/**
 * The band at the bottom of the padded canvas is the page's new (or lost)
 * height, not where the change is: a banner inserted near the top makes the
 * page taller too. The reading places the change with the page shift, says
 * the DOM summary tells what changed, and never calls an identical DOM
 * content added or removed. Found dogfooding testivai-example: the demo's
 * inserted banner (page shift at y=203) was read as "content was added below
 * the baseline's height", and a page laid out 5 px taller on another machine,
 * DOM and styles identical, as content added.
 */
describe('explainHeightChange', () => {
  const NEVER = /below the baseline's height|content was (added|removed)/;
  const changedDom = { changed: true, styleCheck: 'match' as const };

  it('a page shift places the change above the line everything moved from', () => {
    const banner = { baseline: { width: 1280, height: 876 }, candidate: { width: 1280, height: 949 } };
    const text = explainHeightChange(banner, { dom: changedDom, pageShift: { dy: 73, belowY: 203 } });
    expect(text).toBe('everything below y=203 moved down 73 px, so look above that line; every pixel of the added band at the bottom counts as changed');
    expect(text).not.toMatch(NEVER);
  });

  it('a shift up on a shorter page reads up and missing', () => {
    expect(explainHeightChange(shorter, { dom: changedDom, pageShift: { dy: -190, belowY: 600 } })).toBe(
      'everything below y=600 moved up 190 px, so look above that line; every pixel of the missing band at the bottom counts as changed',
    );
  });

  it('a DOM change without a page shift: the summary says what changed, not where', () => {
    const text = explainHeightChange(taller, { dom: changedDom });
    expect(text).toBe(
      'the DOM summary says what changed; every pixel of the added band at the bottom counts as changed, but the change itself can be anywhere on the page',
    );
    expect(text).not.toMatch(NEVER);
  });

  it('an identical DOM with matching styles is the same content laid out differently, often another machine', () => {
    const text = explainHeightChange(
      { baseline: { width: 1280, height: 871 }, candidate: { width: 1280, height: 876 } },
      { dom: { changed: false, styleCheck: 'match' } },
    );
    expect(text).toBe(
      'no elements were added or removed, so the same content is laid out taller (often fonts or rendering that differ between machines); every pixel of the added band at the bottom counts as changed',
    );
    expect(text).not.toMatch(NEVER);
  });

  it('an identical DOM with changed styles is restyled, not content', () => {
    expect(explainHeightChange(shorter, { dom: { changed: false, styleCheck: 'mismatch' } })).toBe(
      'no elements were added or removed, so restyled elements lay the same content out shorter; every pixel of the missing band at the bottom counts as changed',
    );
  });

  it('an identical DOM whose styles were not compared does not rule out a stylesheet change', () => {
    const reading =
      'no elements were added or removed, so the same content is laid out taller (a stylesheet change, or fonts or rendering that differ between machines: styles were not compared); every pixel of the added band at the bottom counts as changed';
    expect(explainHeightChange(taller, { dom: { changed: false, styleCheck: 'unavailable' } })).toBe(reading);
    expect(explainHeightChange(taller, { dom: { changed: false } })).toBe(reading);
  });

  it('an identical DOM with a page shift says both', () => {
    expect(explainHeightChange(taller, { dom: { changed: false, styleCheck: 'match' }, pageShift: { dy: 190, belowY: 40 } })).toBe(
      'no elements were added or removed, so the same content is laid out taller (often fonts or rendering that differ between machines); ' +
        'everything below y=40 moved down 190 px, so look above that line; every pixel of the added band at the bottom counts as changed',
    );
  });

  it('without DOM data or a page shift, it does not guess where', () => {
    expect(explainHeightChange(taller)).toBe('every pixel of the added band at the bottom counts as changed, but the change itself can be anywhere on the page');
    expect(explainHeightChange(taller, { dom: null, pageShift: null })).toBe(explainHeightChange(taller));
  });
});
