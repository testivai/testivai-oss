/**
 * Pixels differ, DOM identical: what the style check makes of it.
 *
 *   styleCheck 'match'        → likely render noise (still not proof), but
 *                               only when the diff is small and scattered
 *                               (see diff-shape.test.ts); concentrated in one
 *                               area or large, it is not called noise
 *   styleCheck 'mismatch'     → a real style-only change, never noise
 *   styleCheck 'unavailable'  → unknown: styles were not compared, so a
 *   (or missing, older runs)    stylesheet-only change is not ruled out
 *
 * noiseHint itself is unchanged (DOM identical AND no style mismatch, so it
 * is still true for 'unavailable'); what changes is how it is consumed: the
 * report never calls the unknown case noise, and noiseAutoPass only passes
 * the 'match' case whose diff is not concentrated in one area.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { applyPassCriteria, compareAll } from '../report/compare';
import type { ReportData, SnapshotResult } from '../report/results';
import { renderHtml } from '../report/template';
import { BLUE, makePng, RED } from './helpers/synth';

/** A real snapshot from fixtures/render-noise-shapes.results.json (fixtures/README.md), as a fresh copy. */
const realRun = (name: string): SnapshotResult => {
  const data: ReportData = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'render-noise-shapes.results.json'), 'utf8'),
  );
  const s = data.snapshots.find((x) => x.name === name);
  if (!s) throw new Error(`no fixture snapshot ${name}`);
  return s;
};

type StyleCheck = 'match' | 'mismatch' | 'unavailable' | undefined;

/** A changed snapshot whose DOM is identical, with the given style verdict. */
const identicalDom = (styleCheck: StyleCheck, extra: Partial<SnapshotResult> = {}): SnapshotResult => {
  const dom: NonNullable<SnapshotResult['dom']> = {
    changed: false,
    summary: null,
    // compareAll clears the hint only on a style mismatch.
    noiseHint: styleCheck !== 'mismatch',
  };
  if (styleCheck !== undefined) dom.styleCheck = styleCheck;
  if (styleCheck === 'mismatch') dom.styleChanges = { count: 1, elements: ['body > button.cta'] };
  return {
    name: 'page',
    status: 'changed',
    diffPercent: 0.4,
    diffCount: 400,
    totalPixels: 100000,
    baselinePath: 'images/page/baseline.png',
    currentPath: 'images/page/current.png',
    diffPath: 'images/page/diff.png',
    dom,
    ...extra,
  };
};

const report = (snapshot: SnapshotResult): string => {
  const data: ReportData = {
    version: '2.3.0',
    timestamp: new Date().toISOString(),
    summary: {
      total: 1,
      passed: snapshot.status === 'passed' ? 1 : 0,
      changed: snapshot.status === 'changed' ? 1 : 0,
      newSnapshots: 0,
    },
    snapshots: [snapshot],
  };
  return renderHtml(data);
};

/** The snapshot cards only: the sidebar explains every case, so keep it out. */
const mainOf = (html: string): string => html.slice(html.indexOf('<main'));

const NOISE_CLAIMS = [/render noise —/i, /likely render noise/i, /not a block/i, /worth a glance/i, /is likely noise/i];

describe('applyPassCriteria: noiseAutoPass needs a style match', () => {
  const criteria = { noiseAutoPass: true, noiseMaxDiffPercent: 1 };

  it("auto-passes when the DOM is identical and styleCheck is 'match'", () => {
    const r = identicalDom('match');
    applyPassCriteria(r, criteria);
    expect(r.status).toBe('passed');
    expect(r.autoPassed).toBe('noise');
  });

  it("stays changed when styleCheck is 'unavailable' (styles not compared)", () => {
    const r = identicalDom('unavailable');
    applyPassCriteria(r, criteria);
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
  });

  it('stays changed when styleCheck is missing (results from before the style check)', () => {
    const r = identicalDom(undefined);
    expect(r.dom?.noiseHint).toBe(true);
    applyPassCriteria(r, criteria);
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
  });

  it("stays changed when styleCheck is 'mismatch'", () => {
    const r = identicalDom('mismatch');
    applyPassCriteria(r, criteria);
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
  });

  it("does not trust styleCheck 'match' alone: the noise hint must be set too", () => {
    const r = identicalDom('match');
    r.dom!.noiseHint = false;
    applyPassCriteria(r, criteria);
    expect(r.status).toBe('changed');
  });

  it("stays changed above noiseMaxDiffPercent even with styleCheck 'match'", () => {
    const r = identicalDom('match', { diffPercent: 1.5 });
    applyPassCriteria(r, criteria);
    expect(r.status).toBe('changed');
  });

  it("stays changed with styleCheck 'match' when noiseAutoPass is off (the default)", () => {
    const r = identicalDom('match');
    applyPassCriteria(r, {});
    expect(r.status).toBe('changed');
  });
});

describe('applyPassCriteria: noiseAutoPass never passes a diff concentrated in one area', () => {
  // noiseMaxDiffPercent 5 so that size is never the reason a case stays changed.
  const criteria = { noiseAutoPass: true, noiseMaxDiffPercent: 5 };

  it.each([
    ['card-clipped', 'a real max-height/overflow bug the style check cannot see'],
    ['card-text-not-painted', 'a bad current capture'],
    ['baseline-band-shifted', 'a bad baseline'],
    ['titles-underlined', 'a real text-decoration change on six cards'],
  ])('%s (%s) stays changed', (name) => {
    const r = realRun(name);
    applyPassCriteria(r, criteria);
    expect(r.status).toBe('changed');
    expect(r.autoPassed).toBeUndefined();
  });

  it.each([['glyph-edge-noise'], ['font-subpixel-noise']])('%s (render noise, scattered) auto-passes', (name) => {
    const r = realRun(name);
    applyPassCriteria(r, criteria);
    expect(r.status).toBe('passed');
    expect(r.autoPassed).toBe('noise');
  });

  it('a spread-out diff is limited by the configured noiseMaxDiffPercent, not by the 1% verdict bound', () => {
    const atDefault = realRun('font-subpixel-noise-over-1pct'); // 1.19%
    applyPassCriteria(atDefault, { noiseAutoPass: true });
    expect(atDefault.status).toBe('changed');

    const raised = realRun('font-subpixel-noise-over-1pct');
    applyPassCriteria(raised, { noiseAutoPass: true, noiseMaxDiffPercent: 2 });
    expect(raised.status).toBe('passed');
    expect(raised.autoPassed).toBe('noise');
  });

  it('other pass criteria still apply to a concentrated diff', () => {
    const r = realRun('card-clipped'); // 0.03%
    applyPassCriteria(r, { ...criteria, maxDiffPercent: 0.05 });
    expect(r.status).toBe('passed');
    expect(r.autoPassed).toBe('threshold');
  });
});

describe('compareAll: noiseAutoPass end to end', () => {
  let root: string;
  let reportDir: string;
  const DOM = '<html><head></head><body><button class="cta">Buy</button></body></html>';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-stylecheck-'));
    reportDir = path.join(root, 'visual-report');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Render-noise-like pixels: isolated single pixels spread over the page,
  // each below the region noise floor. Versus one solid block in one place.
  const specks = Array.from({ length: 24 }, (_, i) => ({ x: 8 + (i % 6) * 36, y: 8 + Math.floor(i / 6) * 36, width: 1, height: 1 }));
  const block = [{ x: 20, y: 20, width: 100, height: 40 }];

  /** Same DOM both sides, different pixels; element maps as given. */
  function writeSnapshot(name: string, maps?: { baseline: string; candidate: string }, changedRects = specks) {
    const bDir = path.join(root, '.testivai', 'baselines', name);
    const tDir = path.join(root, '.testivai', 'temp', name);
    fs.mkdirSync(bDir, { recursive: true });
    fs.mkdirSync(tDir, { recursive: true });
    const box = { x: 20, y: 20, width: 100, height: 40 };
    const paint = (color: typeof RED) => changedRects.map((rect) => ({ rect, color }));
    fs.writeFileSync(path.join(bDir, 'screenshot.png'), makePng(200, 150, undefined, paint(BLUE)));
    fs.writeFileSync(path.join(tDir, 'screenshot.png'), makePng(200, 150, undefined, paint(RED)));
    fs.writeFileSync(path.join(bDir, 'dom.html'), DOM);
    fs.writeFileSync(path.join(tDir, 'dom.html'), DOM);
    if (maps) {
      const map = (styleHash: string) => [{ path: 'body > button.cta', ...box, styleHash }];
      fs.writeFileSync(path.join(bDir, 'elements.json'), JSON.stringify(map(maps.baseline)));
      fs.writeFileSync(path.join(tDir, 'elements.json'), JSON.stringify(map(maps.candidate)));
    }
  }

  const run = () =>
    compareAll({ projectRoot: root, reportDir, passCriteria: { noiseAutoPass: true, noiseMaxDiffPercent: 100 } })[0];

  it('without element maps (the crawler, `testivai run`): stays changed for a human', () => {
    writeSnapshot('no-maps');
    const result = run();
    expect(result.dom!.noiseHint).toBe(true); // the hint itself is unchanged
    expect(result.dom!.styleCheck).toBe('unavailable');
    expect(result.status).toBe('changed');
    expect(result.autoPassed).toBeUndefined();
  });

  it('with maps but no comparable digests: stays changed for a human', () => {
    writeSnapshot('no-digests', { baseline: '', candidate: '' });
    const result = run();
    expect(result.dom!.styleCheck).toBe('unavailable');
    expect(result.status).toBe('changed');
  });

  it('with matching digests and scattered pixels: auto-passes as noise', () => {
    writeSnapshot('digests-match', { baseline: 'aaaa', candidate: 'aaaa' });
    const result = run();
    expect(result.dom!.styleCheck).toBe('match');
    expect(result.regions ?? []).toEqual([]);
    expect(result.status).toBe('passed');
    expect(result.autoPassed).toBe('noise');
  });

  it('with matching digests but one solid block changed: stays changed (concentrated, not noise)', () => {
    writeSnapshot('digests-match-block', { baseline: 'aaaa', candidate: 'aaaa' }, block);
    const result = run();
    expect(result.dom!.styleCheck).toBe('match');
    expect(result.dom!.noiseHint).toBe(true); // the hint itself is unchanged
    expect(result.regions).toHaveLength(1);
    expect(result.status).toBe('changed');
    expect(result.autoPassed).toBeUndefined();
  });
});

describe('HTML report: the three identical-DOM cases', () => {
  describe("styleCheck 'match', small and scattered diff: likely render noise", () => {
    const html = report(identicalDom('match'));
    const main = mainOf(html);

    it('keeps the likely-noise verdict, and says the diff is small and scattered', () => {
      expect(main).toContain(
        '<div class="verdict v-noise"><span>Likely render noise — pixels differ but the DOM and computed styles are identical and the diff is small and scattered (anti-aliasing, font hinting). Worth a glance, not a block.</span></div>',
      );
    });

    it('badge and tooltip name the DOM, the computed styles and the shape of the diff', () => {
      expect(main).toContain('class="dom-hint noise"');
      expect(main).toContain(
        'title="DOM tree and computed styles are identical between baseline and candidate, and the diff is small and scattered; the pixel diff is likely render noise."',
      );
      expect(main).toContain('Styles verified unchanged; the diff is small and scattered.');
    });

    it('real render noise (a re-rasterized page, 20 regions spread out) reads the same', () => {
      const real = mainOf(report(realRun('font-subpixel-noise')));
      expect(real).toContain('<div class="verdict v-noise">');
      expect(real).toContain('class="dom-hint noise"');
    });
  });

  describe("styleCheck 'match', diff concentrated in one area: not noise", () => {
    const html = report(realRun('card-clipped'));
    const main = mainOf(html);

    it('verdict names the area, the two explanations and what to do', () => {
      expect(main).toContain(
        '<div class="verdict v-unexplained"><span>Diff concentrated in one area — the DOM and computed styles are identical, but 3 regions within 155×52 px, 0.8% of the page, changed. Render noise is small and scattered, so this is a bad capture, or a change the style check does not cover (size, overflow, position, transform, text decoration, filters, pseudo-elements, or images and other assets). Compare the images before approving.</span></div>',
      );
    });

    it('badge says the same, in its own style', () => {
      expect(main).toContain(
        '<div class="dom-hint unexplained" title="DOM tree and computed styles are identical, but the pixel diff sits in one area, which render noise does not do.">',
      );
      expect(main).toContain('<span class="label">DOM and styles unchanged, diff in one area</span>');
      expect(main).toContain(
        '— 3 regions within 155×52 px, 0.8% of the page: a bad capture, or a change the style check does not cover. Compare the images.',
      );
    });

    it('never uses the info-blue noise style or calls it likely noise', () => {
      expect(main).not.toContain('v-noise');
      expect(main).not.toContain('dom-hint noise');
      for (const claim of NOISE_CLAIMS) expect(main).not.toMatch(claim);
    });

    it('the warning style reuses the report palette, not the info colors', () => {
      expect(html).toMatch(/\.verdict\.v-unexplained \{[^}]*var\(--new-bg\)[^}]*\}/);
      expect(html).toMatch(/\.dom-hint\.unexplained \{[^}]*var\(--new-bg\)[^}]*\}/);
    });

    it.each([['card-text-not-painted'], ['baseline-band-shifted'], ['titles-underlined']])('%s reads the same way', (name) => {
      const other = mainOf(report(realRun(name)));
      expect(other).toContain('<div class="verdict v-unexplained"><span>Diff concentrated in one area');
      for (const claim of NOISE_CLAIMS) expect(other).not.toMatch(claim);
    });
  });

  describe("styleCheck 'match', large diff spread across the page: not noise", () => {
    const main = mainOf(report(realRun('font-subpixel-noise-over-1pct')));

    it('verdict says it is more than render noise usually changes, and what it often is', () => {
      expect(main).toContain(
        '<div class="verdict v-unexplained"><span>Large diff — the DOM and computed styles are identical, but 1.19% of pixels differ, spread across the page: more than render noise usually changes. Often fonts or rendering that differ between the machines that captured the baseline and the current image; it can also be a bad capture or a change the style check does not cover (size, overflow, position, transform, text decoration, filters, pseudo-elements, or images and other assets). Compare the images before approving.</span></div>',
      );
    });

    it('badge says the same', () => {
      expect(main).toContain(
        '<div class="dom-hint unexplained" title="DOM tree and computed styles are identical, but more pixels differ than render noise usually changes.">',
      );
      expect(main).toContain('<span class="label">DOM and styles unchanged, large diff</span>');
      expect(main).toContain('— 1.19% of pixels differ, spread across the page. Compare the images.');
      for (const claim of NOISE_CLAIMS) expect(main).not.toMatch(claim);
    });
  });

  describe.each([
    ['unavailable', 'unavailable' as StyleCheck],
    ['missing (older results)', undefined as StyleCheck],
  ])('styleCheck %s: styles not compared, not noise', (_label, styleCheck) => {
    const html = report(identicalDom(styleCheck));
    const main = mainOf(html);

    it('verdict says styles were not compared and a stylesheet-only change is not ruled out', () => {
      expect(main).toContain(
        '<div class="verdict v-unverified"><span>Styles not compared — could be render noise or a stylesheet-only change: pixels differ and the DOM is identical, but computed styles were not compared (no comparable style digests on both sides), so a stylesheet-only change is not ruled out. Compare the images before approving.</span></div>',
      );
    });

    it('badge uses its own warning style and says the same', () => {
      expect(main).toContain('class="dom-hint unverified"');
      expect(main).toContain('<span class="label">DOM unchanged, styles not compared</span>');
      expect(main).toContain(
        '— could be render noise or a stylesheet-only change (no comparable style digests on both sides). Compare the images before approving.',
      );
      expect(main).toContain(
        'title="DOM tree is identical between baseline and candidate, but computed styles were not compared, so a stylesheet-only change is not ruled out."',
      );
    });

    it('never uses the info-blue noise style or calls it likely noise', () => {
      expect(main).not.toContain('v-noise');
      expect(main).not.toContain('dom-hint noise');
      for (const claim of NOISE_CLAIMS) expect(main).not.toMatch(claim);
    });

    it('the warning style reuses the report palette, not the info colors', () => {
      expect(html).toMatch(/\.verdict\.v-unverified \{[^}]*var\(--new-bg\)[^}]*\}/);
      expect(html).toMatch(/\.dom-hint\.unverified \{[^}]*var\(--new-bg\)[^}]*\}/);
      expect(html).not.toMatch(/\.verdict\.v-unverified \{[^}]*--info[^}]*\}/);
    });
  });

  describe("styleCheck 'mismatch': a real style-only change", () => {
    const main = mainOf(report(identicalDom('mismatch')));

    it('keeps the style-change verdict and badge', () => {
      expect(main).toContain('Style-only change — a real change, not noise');
      expect(main).toContain('class="dom-hint style-changed"');
      for (const claim of NOISE_CLAIMS) expect(main).not.toMatch(claim);
    });
  });
});

describe('HTML report: the DOM changed and computed styles changed too', () => {
  // A class or style attribute change: the DOM diff sees the attribute, and
  // the restyled elements' digests differ. The style check runs whenever DOM
  // data exists, so this is a mismatch WITH a changed DOM; never "identical DOM".
  const main = mainOf(
    report({
      ...identicalDom('mismatch'),
      dom: {
        changed: true,
        noiseHint: false,
        summary: { added: 0, removed: 0, attributeChanges: 1, textChanges: 0 },
        styleCheck: 'mismatch',
        styleChanges: { count: 2, elements: ['body > button.cta', 'body > a.more'] },
      },
    }),
  );

  it('reads as a structural change, not a style-only one', () => {
    expect(main).toContain('<div class="verdict v-structural">');
    expect(main).not.toContain('Style-only change');
    expect(main).not.toContain('identical DOM');
  });

  it('the badge says the DOM changed and names the restyled elements', () => {
    expect(main).toContain('class="dom-hint changed"');
    expect(main).not.toContain('dom-hint style-changed');
    expect(main).toContain('Computed styles also changed on 2 elements: <code>button.cta</code>, <code>a.more</code>.');
  });
});

describe('HTML report: auto-pass note', () => {
  it("names DOM and computed styles for a 'noise' auto-pass", () => {
    const main = mainOf(report(identicalDom('match', { status: 'passed', autoPassed: 'noise' })));
    expect(main).toContain('auto-passed: DOM and computed styles unchanged, within noise tolerance');
    expect(main).not.toContain('auto-passed: DOM unchanged, within noise tolerance');
  });

  it("does not claim the styles were compared for a legacy 'noise' auto-pass without a style match", () => {
    const main = mainOf(report(identicalDom('unavailable', { status: 'passed', autoPassed: 'noise' })));
    expect(main).toContain('auto-passed: DOM unchanged, styles not compared, within noise tolerance');
    expect(main).not.toContain('computed styles unchanged');
  });

  it("flags a legacy 'noise' auto-pass of a diff concentrated in one area", () => {
    const main = mainOf(report({ ...realRun('card-clipped'), status: 'passed', autoPassed: 'noise' }));
    expect(main).toContain(
      'auto-passed: DOM and computed styles unchanged, within noise tolerance, but the diff is concentrated in one area',
    );
    // An auto-pass has nothing to approve: the verdict says what to do instead.
    expect(main).toContain('Compare the images before relying on the auto-pass.');
    expect(main).not.toContain('before approving');
    for (const claim of NOISE_CLAIMS) expect(main).not.toMatch(claim);
  });
});

describe('HTML report sidebar', () => {
  const html = renderHtml({
    version: '2.3.0',
    timestamp: new Date().toISOString(),
    summary: { total: 0, passed: 0, changed: 0, newSnapshots: 0 },
    snapshots: [],
  });
  const notice = html.slice(html.indexOf('<div class="oss-notice">'), html.indexOf('</aside>'));

  it('no longer says the DOM-unchanged hint alone identifies render noise', () => {
    expect(notice).not.toContain('identifies likely render noise');
    expect(notice).toContain('a stylesheet-only change is not ruled out');
  });

  it('says matching styles mean likely noise only for a small, scattered diff', () => {
    expect(notice).toContain(
      '<strong>DOM unchanged</strong> with matching computed styles means likely render noise only when the diff is also small and scattered; a diff concentrated in one area, or over 1% of pixels, gets its own verdict.',
    );
  });

  it('says what stabilization covers and what dynamic content needs config', () => {
    expect(notice).toContain('stabilized by default');
    expect(notice).not.toMatch(/Dynamic content \(images, fonts, animations\) may cause false positives/);
    for (const option of ['ignoreSelectors', 'mask', 'threshold', 'maxDiffPercent', 'maxDiffPixels', 'shiftTolerance', 'collapse']) {
      expect(notice).toContain(option);
    }
  });

  it('names only the JS/TS Playwright adapter for mode: "collapse" (python/java take plain selectors)', () => {
    expect(notice).toContain('mode: "collapse"</code> (<code>@testivai/witness-playwright</code> only)');
    expect(notice).not.toContain('(Playwright)');
  });
});
