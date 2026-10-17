/**
 * The shared wording for a capture whose dimensions differ from its
 * baseline (report/size-mismatch.ts), used by the HTML report, @testivai/mcp
 * and the GitHub Action so the three surfaces say the same thing.
 */
import { describeSizeChange, formatSizeMismatch, formatSizes, sizeMismatchKind } from '../report/size-mismatch';

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
