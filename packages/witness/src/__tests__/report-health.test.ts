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
