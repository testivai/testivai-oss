/**
 * The PR comment with capture health (results.json 2.7.0 `captureHealth`).
 * An unhealthy capture reads "Unhealthy capture" with what failed, before
 * any environment reading, never "likely render noise"; an unhealthy
 * baseline is called out on every compare against it; passed and new
 * snapshots with an unhealthy capture are said too; warnings are shown and
 * change no reading. Healthy on both sides changes nothing.
 */
import type { CaptureHealth } from '../../../packages/witness/src/capture/health';
import { snapshotCaptureHealth } from '../../../packages/witness/src/report/health';
import { buildComment } from '../comment';
import type { ResultsData, SnapshotResult } from '../types';

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

const ENV_130 = {
  os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
  browser: { name: 'chromium', version: '130.0.6723.58' },
  adapter: { name: '@testivai/witness-playwright', version: '2.0.5', captureMethod: 'full-page:cdp' },
};
const ENV_141 = { ...ENV_130, browser: { name: 'chromium', version: '141.0.7390.37' } };

const noHint = { changed: false, noiseHint: false, summary: null, styleCheck: 'match' as const };
const sameDom = { ...noHint, noiseHint: true };

const changed = (name: string, extra: Partial<SnapshotResult> = {}): SnapshotResult => ({
  name,
  status: 'changed',
  diffPercent: 0.07,
  totalPixels: 921600,
  ...extra,
});

const results = (...snapshots: SnapshotResult[]): ResultsData => ({
  timestamp: 0,
  summary: {
    total: snapshots.length,
    passed: snapshots.filter((s) => s.status === 'passed').length,
    changed: snapshots.filter((s) => s.status === 'changed').length,
    newSnapshots: snapshots.filter((s) => s.status === 'new').length,
  },
  snapshots,
});

const NEXT =
  'An unhealthy capture is a glitch of the capture or a broken asset, not render noise: fix the page, the server or the test and re-run; never approve it as a baseline.';

describe('the PR comment with capture health', () => {
  it('an unhealthy capture with an identical DOM: "Unhealthy capture", never render noise', () => {
    const comment = buildComment(results(changed('home', { dom: noHint, captureHealth: snapshotCaptureHealth(HEALTHY, FONT_FAILED) })));
    expect(comment).toContain(`> **Unhealthy capture** — web font 'Fancy' failed to load, so the page rendered with a fallback font. ${NEXT}`);
    expect(comment).not.toMatch(/render noise \(anti-aliasing/);
  });

  it('an unhealthy baseline is called out: re-baseline from a healthy run', () => {
    const comment = buildComment(results(changed('home', { dom: noHint, captureHealth: snapshotCaptureHealth(CSS_FAILED, HEALTHY) })));
    expect(comment).toContain(
      '> **Unhealthy capture** — the baseline was captured with a failed stylesheet (stylesheet example.com/css/site.css returned 404). Re-baseline from a healthy run.',
    );
  });

  it('unhealthy and rendering drift: both, unhealthy first', () => {
    const comment = buildComment(
      results(
        changed('home', {
          dom: noHint,
          captureHealth: snapshotCaptureHealth(HEALTHY, FONT_FAILED),
          environment: { delta: ['browser.version'], renderingDelta: ['browser.version'], baseline: ENV_130, candidate: ENV_141 },
        }),
      ),
    );
    const unhealthy = comment.indexOf('**Unhealthy capture**');
    const drift = comment.indexOf('**Rendering drift**');
    expect(unhealthy).toBeGreaterThan(-1);
    expect(drift).toBeGreaterThan(unhealthy);
  });

  it('a passed snapshot with an unhealthy capture is said, though nothing changed', () => {
    const comment = buildComment(
      results({ name: 'footer', status: 'passed', diffPercent: 0, captureHealth: snapshotCaptureHealth(FONT_FAILED, FONT_FAILED) }),
    );
    expect(comment).toContain(
      "> **Unhealthy capture** — `footer` passed, but neither image shows the page as built: web font 'Fancy' failed to load, so the page rendered with a fallback font;",
    );
  });

  const SAME_NEXT =
    'The same assets failed in both captures, so the pass tolerances (maxDiffPercent, maxDiffPixels, shiftTolerance) still apply, but this is never render noise and noise auto-pass never applies: fix the broken asset, then re-baseline from a healthy run.';

  it('the same failures on both sides, above the tolerance: the tolerances still apply, never noise', () => {
    const comment = buildComment(results(changed('home', { dom: noHint, captureHealth: snapshotCaptureHealth(CSS_FAILED, CSS_FAILED) })));
    expect(comment).toContain(
      `> **Unhealthy capture** — stylesheet example.com/css/site.css returned 404; the baseline was captured with the same failures. ${SAME_NEXT}`,
    );
    expect(comment).not.toMatch(/likely render noise/);
  });

  it('the same failures on both sides, auto-passed by a tolerance: the criterion named', () => {
    const comment = buildComment(
      results({
        name: 'home',
        status: 'passed',
        diffPercent: 0.15,
        autoPassed: 'threshold',
        dom: noHint,
        captureHealth: snapshotCaptureHealth(CSS_FAILED, CSS_FAILED),
      }),
    );
    expect(comment).toContain(
      "> **Unhealthy capture** — `home` auto-passed by the 'threshold' criterion, but neither image shows the page as built: " +
        `stylesheet example.com/css/site.css returned 404; the baseline was captured with the same failures. ${SAME_NEXT}`,
    );
  });

  it('a new snapshot with an unhealthy capture: said on its line, do not approve it', () => {
    const comment = buildComment(results({ name: 'fresh', status: 'new', captureHealth: snapshotCaptureHealth(null, CSS_FAILED) }));
    expect(comment).toContain('- `fresh` — **unhealthy capture**: stylesheet example.com/css/site.css returned 404; do not approve it as the baseline');
  });

  it('warnings are shown with the snapshot and change no reading', () => {
    const comment = buildComment(results(changed('home', { dom: sameDom, captureHealth: snapshotCaptureHealth(HEALTHY, IMAGE_BROKEN) })));
    expect(comment).toContain('**DOM unchanged** — pixel diff is likely render noise');
    expect(comment).toContain('> Capture warnings — image example.com/img/hero.png did not load.');
  });

  it('healthy on both sides: the comment is what it was without health', () => {
    const without = buildComment(results(changed('home', { dom: sameDom }), { name: 'footer', status: 'passed', diffPercent: 0 }));
    const healthy = buildComment(
      results(
        changed('home', { dom: sameDom, captureHealth: snapshotCaptureHealth(HEALTHY, HEALTHY) }),
        { name: 'footer', status: 'passed', diffPercent: 0, captureHealth: snapshotCaptureHealth(HEALTHY, HEALTHY) },
      ),
    );
    expect(healthy).toBe(without);
  });
});
