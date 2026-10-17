/**
 * The HTML report with capture provenance. When the DOM and computed styles
 * are identical and the rendering environment changed since the baseline,
 * the diff is rendering drift, and the report must say so instead of "likely
 * render noise". When several snapshots share one change, it is said once at
 * the top.
 */
import type { CaptureEnvironment } from '../capture/environment';
import type { ReportData, SnapshotResult } from '../report/results';
import { renderHtml } from '../report/template';

const ENV_130: CaptureEnvironment = {
  os: { platform: 'linux', release: '6.8.0', arch: 'x64', distro: 'ubuntu 24.04' },
  browser: { name: 'chromium', version: '130.0.6723.58', headless: true },
  framework: { name: 'playwright', version: '1.48.2', language: 'typescript' },
  adapter: { name: '@testivai/witness-playwright', version: '2.0.5', captureMethod: 'full-page:cdp' },
};
const ENV_141: CaptureEnvironment = {
  ...ENV_130,
  browser: { ...ENV_130.browser, version: '141.0.7390.37' },
  framework: { ...ENV_130.framework!, version: '1.64.1' },
};

const bump = {
  delta: ['browser.version', 'framework.version'],
  renderingDelta: ['browser.version'],
  baseline: ENV_130,
  candidate: ENV_141,
};

const sameDom = { changed: false, noiseHint: true, summary: null, styleCheck: 'match' as const };

const snap = (name: string, extra: Partial<SnapshotResult> = {}): SnapshotResult => ({
  name,
  status: 'changed',
  diffPercent: 0.4,
  diffCount: 400,
  totalPixels: 100000,
  baselinePath: `images/${name}/baseline.png`,
  currentPath: `images/${name}/current.png`,
  diffPath: `images/${name}/diff.png`,
  ...extra,
});

const report = (...snapshots: SnapshotResult[]): string => {
  const data: ReportData = {
    version: '2.5.0',
    timestamp: '2026-10-17T00:00:00.000Z',
    summary: {
      total: snapshots.length,
      passed: snapshots.filter((s) => s.status === 'passed').length,
      changed: snapshots.filter((s) => s.status === 'changed').length,
      newSnapshots: 0,
    },
    snapshots,
  };
  return renderHtml(data);
};

/** The snapshot cards only: the sidebar explains every case, so keep it out. */
const mainOf = (html: string): string => html.slice(html.indexOf('<main'));
/** Text with tags stripped, repeated until nothing changes so no tag survives a pass. */
const text = (html: string) => {
  let out = html;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/<[^>]*>/g, '');
  } while (out !== previous);
  return out.replace(/\s+/g, ' ');
};

describe('report verdicts with capture provenance', () => {
  it('identical DOM, matching styles, a browser bump: rendering drift, never "likely render noise"', () => {
    const main = text(mainOf(report(snap('home', { dom: sameDom, environment: bump }))));
    expect(main).toContain(
      'Rendering drift — the environment changed since the baseline (chromium 130.0.6723.58 → 141.0.7390.37), and the DOM and computed styles are identical: the machine changed, not the page. Re-baseline once the images are confirmed to match apart from rendering.',
    );
    expect(main).not.toMatch(/likely render noise/i);
  });

  it('the same snapshot without a recorded environment is still likely render noise', () => {
    expect(text(mainOf(report(snap('home', { dom: sameDom }))))).toMatch(/Likely render noise/);
  });

  it('a large spread-out diff with a browser bump is drift too, not "Large diff"', () => {
    const main = text(mainOf(report(snap('home', { diffPercent: 4.2, dom: sameDom, environment: bump }))));
    expect(main).toContain('Rendering drift — the environment changed since the baseline');
    expect(main).not.toMatch(/Large diff/);
  });

  it('context-only changes (a framework patch) are not drift', () => {
    const contextOnly = { delta: ['framework.version'], renderingDelta: [], baseline: ENV_130, candidate: { ...ENV_130, framework: ENV_141.framework } };
    const main = text(mainOf(report(snap('home', { dom: sameDom, environment: contextOnly }))));
    expect(main).toMatch(/Likely render noise/);
    expect(main).not.toMatch(/Rendering drift/);
  });

  it('a diff in one area keeps its own verdict and adds the environment change as context', () => {
    const regions = [{ x: 10, y: 10, width: 50, height: 20, diffPixels: 400, diffPercent: 40 }];
    const main = text(mainOf(report(snap('home', { regions, dom: sameDom, environment: bump }))));
    expect(main).toMatch(/Diff concentrated in one area/);
    expect(main).toContain(
      'The environment also changed since the baseline (chromium 130.0.6723.58 → 141.0.7390.37), which can add rendering differences of its own.',
    );
    expect(main).not.toMatch(/Rendering drift —/);
  });

  it('styles not compared stay unknown, with the environment change as context', () => {
    const main = text(mainOf(report(snap('home', { dom: { ...sameDom, styleCheck: 'unavailable' }, environment: bump }))));
    expect(main).toMatch(/Styles not compared/);
    expect(main).toContain('The environment also changed since the baseline (chromium 130.0.6723.58 → 141.0.7390.37)');
  });

  it('a structural change keeps its verdict and gets the context note', () => {
    const dom = { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0 } };
    const main = text(mainOf(report(snap('home', { dom, environment: bump }))));
    expect(main).toMatch(/Structural change — the DOM differs \(1 added\)/);
    expect(main).toContain('The environment also changed since the baseline');
  });

  it('an auto-passed drift says it is drift and what the tolerance is now measuring', () => {
    const main = text(mainOf(report(snap('home', { status: 'passed', autoPassed: 'noise', dom: sameDom, environment: bump }))));
    expect(main).toContain(
      "Rendering drift — the environment changed since the baseline (chromium 130.0.6723.58 → 141.0.7390.37), and the DOM and computed styles are identical: the machine changed, not the page. Auto-passed by the 'noise' criterion; re-baseline in this environment so the tolerance keeps measuring the page, not the machine.",
    );
  });

  it('the DOM layer says drift too, not render noise', () => {
    const main = text(mainOf(report(snap('home', { dom: sameDom, environment: bump }))));
    expect(main).toContain(
      'DOM unchanged — styles verified unchanged; the environment changed since the baseline, so the pixel diff is rendering drift.',
    );
  });

  it('an environment layer lists every change, rendering first, context after', () => {
    const main = text(mainOf(report(snap('home', { dom: sameDom, environment: bump }))));
    expect(main).toContain('Environment changed since the baseline — chromium 130.0.6723.58 → 141.0.7390.37 · context: playwright 1.48.2 → 1.64.1');
  });

  it('strict policy: says the policy made it changed, whatever the pixels', () => {
    const strict = { ...bump, policy: 'strict' as const };
    const main = text(mainOf(report(snap('home', { diffPercent: 0, diffCount: 0, totalPixels: 0, diffPath: undefined, environment: strict }))));
    expect(main).toContain(
      'Environment changed (strict policy) — chromium 130.0.6723.58 → 141.0.7390.37 since the baseline. environmentPolicy is "strict", so this snapshot is changed whatever its pixels say (0.00% differ). Approve it to re-baseline in this environment, or capture it in the baseline\'s.',
    );
  });

  it('a size change from another capture method says how it was captured, not that the page grew', () => {
    const method: CaptureEnvironment = { ...ENV_130, adapter: { ...ENV_130.adapter, captureMethod: 'viewport:webdriver' } };
    const environment = { delta: ['adapter.captureMethod'], renderingDelta: ['adapter.captureMethod'], baseline: ENV_130, candidate: method };
    const sizeMismatch = { baseline: { width: 1280, height: 2348 }, candidate: { width: 1280, height: 720 } };
    const main = text(mainOf(report(snap('home', { sizeMismatch, dom: sameDom, environment }))));
    expect(main).toContain(
      'Capture method changed — full page (CDP) → viewport (WebDriver) since the baseline (baseline 1280×2348 → current 1280×720): the size change comes from how the screenshot was taken, not from the page. Re-baseline with this capture method, or capture the way the baseline was.',
    );
    expect(main).not.toMatch(/page shrank/);
  });
});

describe('report notice when several snapshots share one environment change', () => {
  it('says it once at the top, with the snapshots', () => {
    const html = report(snap('home', { dom: sameDom, environment: bump }), snap('pricing', { dom: sameDom, environment: bump }));
    const main = text(mainOf(html));
    expect(main).toContain(
      'Environment changed since the baselines (chromium 130.0.6723.58 → 141.0.7390.37): 2 diffs are rendering drift (DOM and computed styles identical), not page changes; re-baseline them once the images are confirmed.',
    );
    expect(main.indexOf('Environment changed since the baselines')).toBeLessThan(main.indexOf('Changed (2)'));
  });

  it('no notice for a single snapshot: its own verdict says it', () => {
    expect(text(mainOf(report(snap('home', { dom: sameDom, environment: bump }))))).not.toContain('since the baselines');
  });
});
