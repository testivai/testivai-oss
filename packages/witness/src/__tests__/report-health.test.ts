/**
 * Capture health, judgment side (report/health.ts): what makes a capture
 * unhealthy, the plain-words reasons, and the reading every surface (report,
 * PR comment, @testivai/mcp) shows. Deterministic: no model involvement.
 */
import type { CaptureHealth } from '../capture/health';
import {
  assessHealth,
  captureHealthReading,
  isUnhealthyCapture,
  sameHealthFailures,
  snapshotCaptureHealth,
} from '../report/health';

const HEALTHY: CaptureHealth = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};

const FONT_404: CaptureHealth = {
  ...HEALTHY,
  fonts: { status: 'loaded', failed: [{ family: 'Fancy', weight: 'normal', style: 'normal' }] },
  resources: { status: 'checked', failed: { font: { count: 1, entries: [{ url: '127.0.0.1:4000/fonts/fancy.ttf', status: 404 }] } } },
};

const CSS_404: CaptureHealth = {
  ...HEALTHY,
  stylesheets: { failed: 1, urls: ['example.com/css/site.css'] },
  resources: { status: 'checked', failed: { css: { count: 1, entries: [{ url: 'example.com/css/site.css', status: 404 }] } } },
};

const IMAGE_404: CaptureHealth = {
  ...HEALTHY,
  images: { broken: 1, urls: ['example.com/img/hero.png'] },
  resources: { status: 'checked', failed: { img: { count: 1, entries: [{ url: 'example.com/img/hero.png', status: 404 }] } } },
};

/** A deep copy: the two sides are separate records, as read from two metadata.json files. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('assessHealth', () => {
  it('a healthy capture: nothing to say', () => {
    expect(assessHealth(HEALTHY)).toEqual({ unhealthy: false, problems: [], reasons: [], warnings: [] });
  });

  it('a web font that failed: unhealthy, named, with the request that failed', () => {
    expect(assessHealth(FONT_404)).toEqual({
      unhealthy: true,
      problems: ['a failed web font'],
      reasons: [
        "web font 'Fancy' failed to load, so the page rendered with a fallback font",
        'font file 127.0.0.1:4000/fonts/fancy.ttf returned 404',
      ],
      warnings: [],
    });
  });

  it('a font file that failed while no face did (the face loaded from its next src): a warning, not unhealthy', () => {
    const fallback: CaptureHealth = {
      ...HEALTHY,
      resources: { status: 'checked', failed: { font: { count: 1, entries: [{ url: 'example.com/fonts/missing.woff2', status: 404 }] } } },
    };
    expect(assessHealth(fallback)).toEqual({
      unhealthy: false,
      problems: [],
      reasons: [],
      warnings: ['font file example.com/fonts/missing.woff2 returned 404'],
    });
  });

  it("a font file that failed with no Font Loading API to say whether a face fell back ('unavailable'): unhealthy", () => {
    const a = assessHealth({
      ...HEALTHY,
      fonts: { status: 'unavailable', failed: [] },
      resources: { status: 'checked', failed: { font: { count: 1, entries: [{ url: 'example.com/fonts/fancy.woff2', status: 404 }] } } },
    });
    expect(a.unhealthy).toBe(true);
    expect(a.problems).toEqual(['a failed web font']);
    expect(a.reasons).toEqual(['font file example.com/fonts/fancy.woff2 returned 404']);
  });

  it('a web font that failed with no request to blame (a local() source): unhealthy', () => {
    const a = assessHealth({ ...HEALTHY, fonts: { status: 'loaded', failed: [{ family: 'Fancy', weight: '400', style: 'normal' }] } });
    expect(a.unhealthy).toBe(true);
    expect(a.reasons).toEqual(["web font 'Fancy' failed to load, so the page rendered with a fallback font"]);
  });

  it('several web fonts: each family once', () => {
    const face = (family: string, weight = '400') => ({ family, weight, style: 'normal' });
    expect(assessHealth({ ...HEALTHY, fonts: { status: 'loaded', failed: [face('A'), face('A', '700'), face('B')] } }).reasons).toEqual([
      "web fonts 'A' and 'B' failed to load, so the page rendered with fallback fonts",
    ]);
    expect(assessHealth({ ...HEALTHY, fonts: { status: 'loaded', failed: [face('A'), face('B'), face('C'), face('D')] } }).reasons).toEqual([
      "web fonts 'A', 'B' and 2 more failed to load, so the page rendered with fallback fonts",
    ]);
  });

  it('web fonts still loading: unhealthy', () => {
    expect(assessHealth({ ...HEALTHY, fonts: { status: 'loading', failed: [] } })).toEqual({
      unhealthy: true,
      problems: ['web fonts still loading'],
      reasons: ['web fonts were still loading when the page was captured'],
      warnings: [],
    });
  });

  it("no Font Loading API ('unavailable'): not checked, not unhealthy", () => {
    expect(assessHealth({ ...HEALTHY, fonts: { status: 'unavailable', failed: [] } }).unhealthy).toBe(false);
  });

  it('a stylesheet that failed: one reason with its status, not two', () => {
    expect(assessHealth(CSS_404)).toEqual({
      unhealthy: true,
      problems: ['a failed stylesheet'],
      reasons: ['stylesheet example.com/css/site.css returned 404'],
      warnings: [],
    });
  });

  it('a stylesheet whose request the page could not see a status for', () => {
    expect(assessHealth({ ...HEALTHY, stylesheets: { failed: 1, urls: ['cdn.example.net/site.css'] } }).reasons).toEqual([
      'stylesheet cdn.example.net/site.css did not load',
    ]);
  });

  it('a stylesheet request that failed without a <link> (an @import), and one that never got a response', () => {
    const a = assessHealth({
      ...HEALTHY,
      resources: {
        status: 'checked',
        failed: {
          css: {
            count: 2,
            entries: [
              { url: 'example.com/css/imported.css', status: 500 },
              { url: 'example.com/css/down.css', status: 0, error: 'net::ERR_CONNECTION_REFUSED' },
            ],
          },
        },
      },
    });
    expect(a.unhealthy).toBe(true);
    expect(a.reasons).toEqual([
      'stylesheet example.com/css/imported.css returned 500',
      'stylesheet example.com/css/down.css failed to load (net::ERR_CONNECTION_REFUSED)',
    ]);
  });

  it('names at most three per kind, then counts the rest', () => {
    const urls = ['a', 'b', 'c', 'd', 'e'].map((n) => `example.com/${n}.css`);
    expect(assessHealth({ ...HEALTHY, stylesheets: { failed: 7, urls } }).reasons).toEqual([
      'stylesheet example.com/a.css did not load',
      'stylesheet example.com/b.css did not load',
      'stylesheet example.com/c.css did not load',
      '4 more stylesheets did not load',
    ]);
  });

  it('broken images alone are a warning, not unhealthy', () => {
    expect(assessHealth(IMAGE_404)).toEqual({
      unhealthy: false,
      problems: [],
      reasons: [],
      warnings: ['image example.com/img/hero.png returned 404'],
    });
    expect(assessHealth({ ...HEALTHY, images: { broken: 2, urls: ['example.com/a.png', 'example.com/b.png'] } }).warnings).toEqual([
      'image example.com/a.png did not load',
      'image example.com/b.png did not load',
    ]);
  });

  it('failed scripts and other requests are warnings', () => {
    const a = assessHealth({
      ...HEALTHY,
      resources: {
        status: 'checked',
        failed: {
          script: { count: 1, entries: [{ url: 'example.com/app.js', status: 500 }] },
          other: { count: 1, entries: [{ url: 'example.com/api/items', status: 503 }] },
          img: { count: 1, entries: [{ url: 'example.com/bg.webp', status: 403 }] },
        },
      },
    });
    expect(a.unhealthy).toBe(false);
    expect(a.warnings).toEqual([
      'image example.com/bg.webp returned 403',
      'script example.com/app.js returned 500',
      'request example.com/api/items returned 503',
    ]);
  });
});

describe('snapshotCaptureHealth', () => {
  it('absent when neither side recorded health: not checked', () => {
    expect(snapshotCaptureHealth(null, null)).toBeUndefined();
  });

  it('healthy on both sides: recorded, nothing unhealthy', () => {
    expect(snapshotCaptureHealth(HEALTHY, HEALTHY)).toEqual({ candidate: HEALTHY, baseline: HEALTHY, unhealthy: null, reasons: [], warnings: [] });
  });

  it("an unhealthy current capture: 'candidate'", () => {
    expect(snapshotCaptureHealth(HEALTHY, FONT_404)).toEqual({
      candidate: FONT_404,
      baseline: HEALTHY,
      unhealthy: 'candidate',
      reasons: assessHealth(FONT_404).reasons,
      warnings: [],
    });
  });

  it("an unhealthy baseline: 'baseline', its reasons marked as the baseline's", () => {
    expect(snapshotCaptureHealth(CSS_404, HEALTHY)).toEqual({
      candidate: HEALTHY,
      baseline: CSS_404,
      unhealthy: 'baseline',
      reasons: ['baseline: stylesheet example.com/css/site.css returned 404'],
      warnings: [],
    });
  });

  it("both: 'both', the current capture's reasons first", () => {
    const h = snapshotCaptureHealth(CSS_404, FONT_404);
    expect(h?.unhealthy).toBe('both');
    expect(h?.reasons).toEqual([...assessHealth(FONT_404).reasons, 'baseline: stylesheet example.com/css/site.css returned 404']);
  });

  it('one side unrecorded: only the recorded side is judged', () => {
    expect(snapshotCaptureHealth(null, FONT_404)).toEqual({ candidate: FONT_404, unhealthy: 'candidate', reasons: assessHealth(FONT_404).reasons, warnings: [] });
    expect(snapshotCaptureHealth(HEALTHY, null)).toEqual({ baseline: HEALTHY, unhealthy: null, reasons: [], warnings: [] });
  });

  it('warnings from both sides, the baseline marked', () => {
    expect(snapshotCaptureHealth(IMAGE_404, IMAGE_404)?.warnings).toEqual([
      'image example.com/img/hero.png returned 404',
      'baseline: image example.com/img/hero.png returned 404',
    ]);
  });
});

describe('captureHealthReading', () => {
  it('none for a healthy or unrecorded snapshot', () => {
    expect(captureHealthReading(undefined)).toBeNull();
    expect(captureHealthReading(snapshotCaptureHealth(HEALTHY, HEALTHY))).toBeNull();
    expect(captureHealthReading(snapshotCaptureHealth(HEALTHY, IMAGE_404))).toBeNull();
  });

  it('an unhealthy current capture: the reasons, then a glitch or broken asset to fix, never to approve', () => {
    expect(captureHealthReading(snapshotCaptureHealth(HEALTHY, FONT_404))).toEqual({
      side: 'candidate',
      detail: "web font 'Fancy' failed to load, so the page rendered with a fallback font; font file 127.0.0.1:4000/fonts/fancy.ttf returned 404",
      next:
        'an unhealthy capture is a glitch of the capture or a broken asset, not render noise: fix the page, the server or the test and re-run; never approve it as a baseline',
    });
  });

  it('an unhealthy baseline: called out, re-baseline from a healthy run', () => {
    expect(captureHealthReading(snapshotCaptureHealth(CSS_404, HEALTHY))).toEqual({
      side: 'baseline',
      detail: 'the baseline was captured with a failed stylesheet (stylesheet example.com/css/site.css returned 404)',
      next: 're-baseline from a healthy run',
    });
  });

  it('both: the current capture first, then the baseline', () => {
    expect(captureHealthReading(snapshotCaptureHealth(CSS_404, FONT_404))).toEqual({
      side: 'both',
      detail:
        "web font 'Fancy' failed to load, so the page rendered with a fallback font; font file 127.0.0.1:4000/fonts/fancy.ttf returned 404; " +
        'the baseline was captured with a failed stylesheet too (stylesheet example.com/css/site.css returned 404)',
      next:
        'an unhealthy capture is a glitch of the capture or a broken asset, not render noise: fix the page, the server or the test and re-run; never approve it as a baseline, and re-baseline from a healthy run',
    });
  });

  it('reads results written by another tool from the reasons alone', () => {
    expect(
      captureHealthReading({ unhealthy: 'baseline', reasons: ['baseline: web fonts were still loading when the page was captured'], warnings: [] }),
    ).toEqual({
      side: 'baseline',
      detail: 'the baseline was captured unhealthy (web fonts were still loading when the page was captured)',
      next: 're-baseline from a healthy run',
    });
  });
});

describe('isUnhealthyCapture', () => {
  it('true only when a side is unhealthy', () => {
    expect(isUnhealthyCapture({})).toBe(false);
    expect(isUnhealthyCapture({ captureHealth: snapshotCaptureHealth(HEALTHY, IMAGE_404) })).toBe(false);
    expect(isUnhealthyCapture({ captureHealth: snapshotCaptureHealth(CSS_404, HEALTHY) })).toBe(true);
  });
});

describe('sameHealthFailures', () => {
  const withFonts = (fonts: CaptureHealth['fonts']['failed']): CaptureHealth => ({ ...FONT_404, fonts: { status: 'loaded', failed: fonts } });
  const fontRequests = (entries: Array<{ url: string; status: number; error?: string }>, count = entries.length): CaptureHealth => ({
    ...FONT_404,
    resources: { status: 'checked', failed: { font: { count, entries } } },
  });

  it('the same failed font and request on both sides: the same', () => {
    expect(sameHealthFailures(FONT_404, clone(FONT_404))).toBe(true);
    expect(sameHealthFailures(CSS_404, clone(CSS_404))).toBe(true);
  });

  it('a different failure: not the same', () => {
    expect(sameHealthFailures(CSS_404, FONT_404)).toBe(false);
    expect(sameHealthFailures(FONT_404, { ...FONT_404, stylesheets: CSS_404.stylesheets, resources: { status: 'checked', failed: { ...FONT_404.resources.failed, ...CSS_404.resources.failed } } })).toBe(false);
  });

  it('the same font file with another status, or on another port: not the same', () => {
    expect(sameHealthFailures(FONT_404, fontRequests([{ url: '127.0.0.1:4000/fonts/fancy.ttf', status: 500 }]))).toBe(false);
    expect(sameHealthFailures(FONT_404, fontRequests([{ url: '127.0.0.1:4001/fonts/fancy.ttf', status: 404 }]))).toBe(false);
  });

  it('the same family with another weight or style: not the same', () => {
    expect(sameHealthFailures(FONT_404, withFonts([{ family: 'Fancy', weight: '700', style: 'normal' }]))).toBe(false);
    expect(sameHealthFailures(FONT_404, withFonts([{ family: 'Fancy', weight: 'normal', style: 'italic' }]))).toBe(false);
  });

  it('the order the failures were listed in does not matter', () => {
    const a = { family: 'A', weight: 'normal', style: 'normal' };
    const b = { family: 'B', weight: 'normal', style: 'normal' };
    expect(sameHealthFailures(withFonts([a, b]), withFonts([b, a]))).toBe(true);
    const x = { url: 'example.com/a.woff2', status: 404 };
    const y = { url: 'example.com/b.woff2', status: 404 };
    expect(sameHealthFailures(fontRequests([x, y]), fontRequests([y, x]))).toBe(true);
  });

  it('a request that failed without a status: the same whatever the error text says', () => {
    const refused = fontRequests([{ url: 'fonts.example.com/fancy.woff2', status: 0, error: 'net::ERR_CONNECTION_REFUSED' }]);
    const unresolved = fontRequests([{ url: 'fonts.example.com/fancy.woff2', status: 0, error: 'net::ERR_NAME_NOT_RESOLVED' }]);
    expect(sameHealthFailures(refused, unresolved)).toBe(true);
  });

  it('web fonts still loading on either side: never the same (the capture depends on timing)', () => {
    const loading: CaptureHealth = { ...HEALTHY, fonts: { status: 'loading', failed: [] } };
    expect(sameHealthFailures(loading, clone(loading))).toBe(false);
    expect(sameHealthFailures({ ...FONT_404, fonts: { ...FONT_404.fonts, status: 'loading' } }, FONT_404)).toBe(false);
  });

  it('a different Font Loading API or request-status coverage: not the same', () => {
    expect(sameHealthFailures(FONT_404, { ...FONT_404, fonts: { ...FONT_404.fonts, status: 'unavailable' } })).toBe(false);
    expect(sameHealthFailures(FONT_404, { ...FONT_404, resources: { ...FONT_404.resources, status: 'unavailable' } })).toBe(false);
  });

  it('a list cut at the cap, or a count above its entries: cannot be proven the same', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ family: `F${i}`, weight: 'normal', style: 'normal' }));
    expect(sameHealthFailures(withFonts(ten), withFonts(clone(ten)))).toBe(false);
    const cut = fontRequests([{ url: '127.0.0.1:4000/fonts/fancy.ttf', status: 404 }], 12);
    expect(sameHealthFailures(cut, clone(cut))).toBe(false);
    const sheets: CaptureHealth = { ...CSS_404, stylesheets: { failed: 11, urls: ['example.com/css/site.css'] } };
    expect(sameHealthFailures(sheets, clone(sheets))).toBe(false);
  });

  it('broken images, failed scripts and other requests are warnings: they do not count', () => {
    const noisy: CaptureHealth = {
      ...FONT_404,
      images: { broken: 1, urls: ['example.com/img/hero.gif'] },
      resources: {
        status: 'checked',
        failed: {
          ...FONT_404.resources.failed,
          img: { count: 1, entries: [{ url: 'example.com/img/hero.gif', status: 404 }] },
          script: { count: 1, entries: [{ url: 'example.com/js/ads.js', status: 503 }] },
        },
      },
    };
    expect(sameHealthFailures(FONT_404, noisy)).toBe(true);
  });
});

describe('snapshotCaptureHealth: sameOnBothSides', () => {
  it('set when both sides are unhealthy with the same failures', () => {
    expect(snapshotCaptureHealth(FONT_404, clone(FONT_404))).toEqual({
      candidate: FONT_404,
      baseline: FONT_404,
      unhealthy: 'both',
      sameOnBothSides: true,
      reasons: [...assessHealth(FONT_404).reasons, ...assessHealth(FONT_404).reasons.map((r) => `baseline: ${r}`)],
      warnings: [],
    });
  });

  it('absent when the failures differ, when one side is unhealthy, or when neither is', () => {
    expect(snapshotCaptureHealth(CSS_404, FONT_404)).not.toHaveProperty('sameOnBothSides');
    expect(snapshotCaptureHealth(HEALTHY, FONT_404)).not.toHaveProperty('sameOnBothSides');
    expect(snapshotCaptureHealth(FONT_404, HEALTHY)).not.toHaveProperty('sameOnBothSides');
    expect(snapshotCaptureHealth(HEALTHY, HEALTHY)).not.toHaveProperty('sameOnBothSides');
    expect(snapshotCaptureHealth(IMAGE_404, IMAGE_404)).not.toHaveProperty('sameOnBothSides');
  });
});

describe('captureHealthReading: the same failures on both sides', () => {
  it('names the failures once, says the baseline has the same, and that the tolerances still apply but never noise', () => {
    expect(captureHealthReading(snapshotCaptureHealth(FONT_404, clone(FONT_404)))).toEqual({
      side: 'both',
      sameOnBothSides: true,
      detail:
        "web font 'Fancy' failed to load, so the page rendered with a fallback font; font file 127.0.0.1:4000/fonts/fancy.ttf returned 404; " +
        'the baseline was captured with the same failures',
      next:
        'the same assets failed in both captures, so the pass tolerances (maxDiffPercent, maxDiffPixels, shiftTolerance) still apply, but this is never render noise and noise auto-pass never applies: fix the broken asset, then re-baseline from a healthy run',
    });
  });

  it('reads results written by another tool (no blocks) from the flag and the reasons', () => {
    const reading = captureHealthReading({
      unhealthy: 'both',
      sameOnBothSides: true,
      reasons: ['stylesheet example.com/css/site.css returned 404', 'baseline: stylesheet example.com/css/site.css returned 404'],
      warnings: [],
    });
    expect(reading?.sameOnBothSides).toBe(true);
    expect(reading?.detail).toBe('stylesheet example.com/css/site.css returned 404; the baseline was captured with the same failures');
  });
});
