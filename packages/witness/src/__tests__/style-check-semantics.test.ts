/**
 * Pixels differ, DOM identical: what the style check makes of it.
 *
 *   styleCheck 'match'        → likely render noise (still not proof)
 *   styleCheck 'mismatch'     → a real style-only change, never noise
 *   styleCheck 'unavailable'  → unknown: styles were not compared, so a
 *   (or missing, older runs)    stylesheet-only change is not ruled out
 *
 * noiseHint itself is unchanged (DOM identical AND no style mismatch, so it
 * is still true for 'unavailable'); what changes is how it is consumed: the
 * report never calls the unknown case noise, and noiseAutoPass only passes
 * the 'match' case.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { applyPassCriteria, compareAll } from '../report/compare';
import type { ReportData, SnapshotResult } from '../report/results';
import { renderHtml } from '../report/template';
import { BLUE, makePng, RED } from './helpers/synth';

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

  /** Same DOM both sides, different pixels; element maps as given. */
  function writeSnapshot(name: string, maps?: { baseline: string; candidate: string }) {
    const bDir = path.join(root, '.testivai', 'baselines', name);
    const tDir = path.join(root, '.testivai', 'temp', name);
    fs.mkdirSync(bDir, { recursive: true });
    fs.mkdirSync(tDir, { recursive: true });
    const box = { x: 20, y: 20, width: 100, height: 40 };
    fs.writeFileSync(path.join(bDir, 'screenshot.png'), makePng(200, 150, undefined, [{ rect: box, color: BLUE }]));
    fs.writeFileSync(path.join(tDir, 'screenshot.png'), makePng(200, 150, undefined, [{ rect: box, color: RED }]));
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

  it('with matching digests: auto-passes as noise', () => {
    writeSnapshot('digests-match', { baseline: 'aaaa', candidate: 'aaaa' });
    const result = run();
    expect(result.dom!.styleCheck).toBe('match');
    expect(result.status).toBe('passed');
    expect(result.autoPassed).toBe('noise');
  });
});

describe('HTML report: the three identical-DOM cases', () => {
  describe("styleCheck 'match': likely render noise", () => {
    const html = report(identicalDom('match'));
    const main = mainOf(html);

    it('keeps the likely-noise verdict', () => {
      expect(main).toContain(
        '<div class="verdict v-noise"><span>Likely render noise — pixels differ but the DOM and computed styles are identical (anti-aliasing, font hinting). Worth a glance, not a block.</span></div>',
      );
    });

    it('badge and tooltip name both the DOM and the computed styles', () => {
      expect(main).toContain('class="dom-hint noise"');
      expect(main).toContain(
        'title="DOM tree and computed styles are identical between baseline and candidate; the pixel diff is likely render noise."',
      );
      expect(main).toContain('Styles verified unchanged.');
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
