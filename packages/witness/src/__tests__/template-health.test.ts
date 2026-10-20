/**
 * The HTML report with capture health. An unhealthy capture reads
 * "Unhealthy capture" on its card, with what failed in plain words, before
 * any other reading: never "likely render noise". An unhealthy baseline is
 * called out on every compare against it. Warnings (broken images) are shown
 * as a layer and change no verdict.
 */
import type { CaptureEnvironment } from '../capture/environment';
import type { CaptureHealth } from '../capture/health';
import { snapshotCaptureHealth } from '../report/health';
import type { ReportData, SnapshotResult } from '../report/results';
import { renderHtml } from '../report/template';

const HEALTHY: CaptureHealth = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};
const FONT_FAILED: CaptureHealth = { ...HEALTHY, fonts: { status: 'loaded', failed: [{ family: 'Fancy', weight: 'normal', style: 'normal' }] } };
const CSS_FAILED: CaptureHealth = {
  ...HEALTHY,
  stylesheets: { failed: 1, urls: ['example.com/css/site.css'] },
  resources: { status: 'checked', failed: { css: { count: 1, entries: [{ url: 'example.com/css/site.css', status: 404 }] } } },
};
const IMAGE_BROKEN: CaptureHealth = { ...HEALTHY, images: { broken: 1, urls: ['example.com/img/hero.png'] } };

const ENV_130: CaptureEnvironment = {
  os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
  browser: { name: 'chromium', version: '130.0.6723.58' },
  adapter: { name: '@testivai/witness-playwright', version: '2.0.5', captureMethod: 'full-page:cdp' },
};
const ENV_141: CaptureEnvironment = { ...ENV_130, browser: { name: 'chromium', version: '141.0.7390.37' } };

/** What compare writes for an unhealthy side: the noise hint cleared. */
const sameDomNoHint = { changed: false, noiseHint: false, summary: null, styleCheck: 'match' as const };
const sameDom = { ...sameDomNoHint, noiseHint: true };

const snap = (name: string, extra: Partial<SnapshotResult> = {}): SnapshotResult => ({
  name,
  status: 'changed',
  diffPercent: 0.07,
  diffCount: 678,
  totalPixels: 921600,
  baselinePath: `images/${name}/baseline.png`,
  currentPath: `images/${name}/current.png`,
  diffPath: `images/${name}/diff.png`,
  ...extra,
});

const report = (...snapshots: SnapshotResult[]): string => {
  const data: ReportData = {
    version: '2.7.0',
    timestamp: '2026-10-19T00:00:00.000Z',
    summary: {
      total: snapshots.length,
      passed: snapshots.filter((s) => s.status === 'passed').length,
      changed: snapshots.filter((s) => s.status === 'changed').length,
      newSnapshots: snapshots.filter((s) => s.status === 'new').length,
    },
    snapshots,
  };
  return renderHtml(data);
};

const mainOf = (html: string): string => html.slice(html.indexOf('<main'));
/** Text with tags stripped (repeated until nothing changes) and the escapes the template writes read back. */
const text = (html: string) => {
  let out = html;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/<[^>]*>/g, '');
  } while (out !== previous);
  return out
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
};

describe('report verdicts with capture health', () => {
  it('an unhealthy capture with an identical DOM: "Unhealthy capture", the font named, never "likely render noise"', () => {
    const main = text(mainOf(report(snap('home', { dom: sameDomNoHint, captureHealth: snapshotCaptureHealth(HEALTHY, FONT_FAILED) }))));
    expect(main).toContain(
      "Unhealthy capture — web font 'Fancy' failed to load, so the page rendered with a fallback font. An unhealthy capture is a glitch of the capture or a broken asset, not render noise: fix the page, the server or the test and re-run; never approve it as a baseline.",
    );
    expect(main).not.toMatch(/likely render noise/i);
  });

  it('an unhealthy baseline is called out: re-baseline from a healthy run', () => {
    const main = text(mainOf(report(snap('home', { dom: sameDomNoHint, captureHealth: snapshotCaptureHealth(CSS_FAILED, HEALTHY) }))));
    expect(main).toContain(
      'Unhealthy capture — the baseline was captured with a failed stylesheet (stylesheet example.com/css/site.css returned 404). Re-baseline from a healthy run.',
    );
  });

  it('unhealthy and rendering drift: both said, unhealthy first', () => {
    const main = text(
      mainOf(
        report(
          snap('home', {
            dom: sameDomNoHint,
            captureHealth: snapshotCaptureHealth(HEALTHY, FONT_FAILED),
            environment: { delta: ['browser.version'], renderingDelta: ['browser.version'], baseline: ENV_130, candidate: ENV_141 },
          }),
        ),
      ),
    );
    const unhealthy = main.indexOf('Unhealthy capture —');
    const drift = main.indexOf('Rendering drift too — the environment changed since the baseline (chromium 130.0.6723.58 → 141.0.7390.37)');
    expect(unhealthy).toBeGreaterThan(-1);
    expect(drift).toBeGreaterThan(unhealthy);
  });

  it('a passed snapshot with an unhealthy capture still shows it', () => {
    const main = text(
      mainOf(report(snap('home', { status: 'passed', diffPercent: 0, diffCount: 0, captureHealth: snapshotCaptureHealth(CSS_FAILED, FONT_FAILED) }))),
    );
    expect(main).toContain(
      "Unhealthy capture — web font 'Fancy' failed to load, so the page rendered with a fallback font; the baseline was captured with a failed stylesheet too (stylesheet example.com/css/site.css returned 404). It passed, but neither image shows the page as built:",
    );
  });

  const SAME_NEXT =
    'the same assets failed in both captures, so the pass tolerances (maxDiffPercent, maxDiffPixels, shiftTolerance) still apply, but this is never render noise and noise auto-pass never applies: fix the broken asset, then re-baseline from a healthy run.';

  it('the same failures on both sides, auto-passed by a tolerance: the criterion named, never noise', () => {
    const main = text(
      mainOf(
        report(
          snap('home', { status: 'passed', autoPassed: 'threshold', dom: sameDomNoHint, captureHealth: snapshotCaptureHealth(FONT_FAILED, FONT_FAILED) }),
        ),
      ),
    );
    expect(main).toContain(
      "Unhealthy capture — web font 'Fancy' failed to load, so the page rendered with a fallback font; the baseline was captured with the same failures. " +
        `It auto-passed by the 'threshold' criterion, but neither image shows the page as built: ${SAME_NEXT}`,
    );
    expect(main).not.toMatch(/likely render noise/i);
  });

  it('the same failures on both sides, above the tolerance: changed, the tolerances still apply', () => {
    const main = text(mainOf(report(snap('home', { dom: sameDomNoHint, captureHealth: snapshotCaptureHealth(CSS_FAILED, CSS_FAILED) }))));
    expect(main).toContain(
      'Unhealthy capture — stylesheet example.com/css/site.css returned 404; the baseline was captured with the same failures. ' +
        SAME_NEXT.charAt(0).toUpperCase() +
        SAME_NEXT.slice(1),
    );
  });

  it('a first capture that is unhealthy: do not approve it', () => {
    const main = text(
      mainOf(report(snap('fresh', { status: 'new', baselinePath: undefined, diffPath: undefined, captureHealth: snapshotCaptureHealth(null, CSS_FAILED) }))),
    );
    expect(main).toContain('Unhealthy capture — stylesheet example.com/css/site.css returned 404. This is a first capture: an unhealthy capture');
    expect(main).not.toContain('First capture — no baseline yet');
  });

  it('a broken image alone: the noise reading stays, and the warning is shown as a layer', () => {
    const main = text(mainOf(report(snap('home', { dom: sameDom, captureHealth: snapshotCaptureHealth(HEALTHY, IMAGE_BROKEN) }))));
    expect(main).toMatch(/Likely render noise/);
    expect(main).toContain('Capture warnings — image example.com/img/hero.png did not load');
  });

  it('healthy on both sides: the card reads as it did without health', () => {
    const without = mainOf(report(snap('home', { dom: sameDom })));
    const healthy = mainOf(report(snap('home', { dom: sameDom, captureHealth: snapshotCaptureHealth(HEALTHY, HEALTHY) })));
    expect(healthy).toBe(without);
  });

  it('escapes every health value it shows', () => {
    const PAYLOAD = '"><img src=x onerror=alert(1)>';
    const html = report(
      snap('home', {
        dom: sameDomNoHint,
        captureHealth: { unhealthy: 'both', reasons: [PAYLOAD, `baseline: ${PAYLOAD}`], warnings: [PAYLOAD] },
      }),
    );
    expect(html).not.toContain('<img src=x');
  });
});
