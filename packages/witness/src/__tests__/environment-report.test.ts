/**
 * Capture provenance, compare side (report/environment.ts): what changed
 * between the environment that captured the baseline and the one that
 * captured the current image, and how the report, MCP and the action word it.
 */
import type { CaptureEnvironment } from '../capture/environment';
import {
  commonEnvironment,
  describeCaptureMethod,
  describeEnvironmentChange,
  diffEnvironments,
  environmentChangeGroups,
  environmentChangeLine,
  isRenderingDrift,
} from '../report/environment';
import type { SnapshotResult } from '../report/results';

const baseline: CaptureEnvironment = {
  os: { platform: 'linux', release: '6.8.0-1017-azure', arch: 'x64', distro: 'ubuntu 22.04' },
  browser: { name: 'chromium', version: '130.0.6723.58', headless: true },
  framework: { name: 'playwright', version: '1.48.2', language: 'typescript', runner: '@playwright/test' },
  adapter: { name: '@testivai/witness-playwright', version: '2.0.5', captureMethod: 'full-page:cdp' },
  render: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US', timezone: 'UTC' },
  ci: { provider: 'github-actions', runnerImage: 'ubuntu22/20250901.1' },
  project: 'chromium',
};

const bumped = (patch: Partial<CaptureEnvironment>): CaptureEnvironment => ({ ...baseline, ...patch });

describe('diffEnvironments', () => {
  it('identical environments: no delta', () => {
    expect(diffEnvironments(baseline, { ...baseline })).toEqual({ delta: [], renderingDelta: [] });
  });

  it('a browser version bump is a rendering change', () => {
    const d = diffEnvironments(baseline, bumped({ browser: { ...baseline.browser, version: '141.0.7390.37' } }));
    expect(d).toEqual({ delta: ['browser.version'], renderingDelta: ['browser.version'] });
  });

  it('a capture-method change is a rendering change', () => {
    const d = diffEnvironments(baseline, bumped({ adapter: { ...baseline.adapter, captureMethod: 'viewport:webdriver' } }));
    expect(d.renderingDelta).toEqual(['adapter.captureMethod']);
  });

  // Framework, adapter and driver versions, the CI runner image and the
  // project name are context: they are listed in the delta but never make a
  // diff "rendering drift" on their own.
  it('context fields are in the delta but not the rendering delta', () => {
    const d = diffEnvironments(
      baseline,
      bumped({
        framework: { ...baseline.framework!, version: '1.64.1' },
        adapter: { ...baseline.adapter, version: '2.0.7' },
        ci: { provider: 'github-actions', runnerImage: 'ubuntu22/20251012.1' },
      }),
    );
    expect(d.delta).toEqual(['adapter.version', 'ci.runnerImage', 'framework.version']);
    expect(d.renderingDelta).toEqual([]);
  });

  // The Linux kernel does not draw text; the distro (fonts, FreeType) does.
  // On macOS and Windows the release is the OS version, which does.
  it('os.release is rendering on darwin and win32, context on linux; os.distro is rendering', () => {
    const linux = diffEnvironments(baseline, bumped({ os: { ...baseline.os, release: '6.11.0-1012-azure' } }));
    expect(linux).toEqual({ delta: ['os.release'], renderingDelta: [] });

    const distro = diffEnvironments(baseline, bumped({ os: { ...baseline.os, distro: 'ubuntu 24.04' } }));
    expect(distro.renderingDelta).toEqual(['os.distro']);

    const mac = { ...baseline, os: { platform: 'darwin', release: '24.6.0', arch: 'arm64' } };
    expect(diffEnvironments(mac, { ...mac, os: { ...mac.os, release: '25.0.0' } }).renderingDelta).toEqual(['os.release']);
  });

  it('a field recorded on one side only is unknown, not a change, except presence fields', () => {
    const { render: _render, ...noRender } = baseline;
    expect(diffEnvironments(noRender as CaptureEnvironment, baseline)).toEqual({ delta: [], renderingDelta: [] });

    // container, label and the CI provider are always decided by the collector,
    // so their absence means "no".
    const local = { ...baseline, ci: undefined };
    // ci.runnerImage is only compared when both sides recorded one.
    expect(diffEnvironments(local, baseline).delta).toEqual(['ci.provider']);
    expect(diffEnvironments(baseline, { ...baseline, container: true }).renderingDelta).toEqual(['container']);
    expect(diffEnvironments(baseline, { ...baseline, label: 'pw-1.64' }).renderingDelta).toEqual(['label']);
  });

  it('render fields are compared one by one, the viewport as WxH', () => {
    const d = diffEnvironments(
      baseline,
      bumped({ render: { ...baseline.render, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 } }),
    );
    expect(d.renderingDelta).toEqual(['render.deviceScaleFactor', 'render.viewport']);
  });
});

describe('describeCaptureMethod', () => {
  it('reads the extent and the mechanism', () => {
    expect(describeCaptureMethod('full-page:cdp')).toBe('full page (CDP)');
    expect(describeCaptureMethod('full-page:playwright')).toBe('full page (Playwright)');
    expect(describeCaptureMethod('full-page:stitched')).toBe('full page (scroll and stitch)');
    expect(describeCaptureMethod('full-page:firefox')).toBe('full page (Firefox)');
    expect(describeCaptureMethod('viewport:webdriver')).toBe('viewport (WebDriver)');
  });

  it('passes an unknown method through unchanged', () => {
    expect(describeCaptureMethod('mystery')).toBe('mystery');
  });
});

describe('describeEnvironmentChange', () => {
  it('a browser version bump', () => {
    const candidate = bumped({ browser: { ...baseline.browser, version: '141.0.7390.37' } });
    expect(describeEnvironmentChange(baseline, candidate, ['browser.version'])).toBe('chromium 130.0.6723.58 → 141.0.7390.37');
  });

  it('a browser change names both browsers', () => {
    const candidate = bumped({ browser: { name: 'firefox', version: '143.0' } });
    expect(describeEnvironmentChange(baseline, candidate, ['browser.name', 'browser.version'])).toBe(
      'chromium 130.0.6723.58 → firefox 143.0',
    );
  });

  it('several changes, in a fixed order, each with its values', () => {
    const candidate = bumped({
      browser: { ...baseline.browser, version: '141.0.7390.37' },
      os: { ...baseline.os, distro: 'ubuntu 24.04' },
      adapter: { ...baseline.adapter, captureMethod: 'viewport:webdriver' },
      render: { ...baseline.render, deviceScaleFactor: 2 },
    });
    expect(
      describeEnvironmentChange(baseline, candidate, ['adapter.captureMethod', 'browser.version', 'os.distro', 'render.deviceScaleFactor']),
    ).toBe(
      'chromium 130.0.6723.58 → 141.0.7390.37, ubuntu 22.04 → ubuntu 24.04, device scale 1 → 2, capture method full page (CDP) → viewport (WebDriver)',
    );
  });

  it('presence fields read as yes/no and none', () => {
    expect(describeEnvironmentChange(baseline, { ...baseline, container: true }, ['container'])).toBe('container no → yes');
    expect(describeEnvironmentChange(baseline, { ...baseline, label: 'pw-1.64' }, ['label'])).toBe('environment label none → pw-1.64');
  });
});

const changed = (name: string, extra: Partial<SnapshotResult>): SnapshotResult => ({
  name,
  status: 'changed',
  diffPercent: 0.4,
  diffCount: 400,
  totalPixels: 100000,
  ...extra,
});

const drifted = (renderingDelta: string[] = ['browser.version']) => ({
  baseline,
  candidate: bumped({ browser: { ...baseline.browser, version: '141.0.7390.37' } }),
  delta: renderingDelta,
  renderingDelta,
});

const sameDom = { changed: false, noiseHint: true, summary: null, styleCheck: 'match' as const };

describe('isRenderingDrift', () => {
  it('pixels differ, the DOM and computed styles match, the environment changed: drift', () => {
    expect(isRenderingDrift(changed('a', { dom: sameDom, environment: drifted() }))).toBe(true);
  });

  it('a large spread-out diff with matching styles and a changed environment is drift too', () => {
    expect(isRenderingDrift(changed('a', { diffPercent: 4.7, dom: sameDom, environment: drifted() }))).toBe(true);
  });

  it('never drift without a rendering change in the environment', () => {
    expect(isRenderingDrift(changed('a', { dom: sameDom }))).toBe(false);
    expect(isRenderingDrift(changed('a', { dom: sameDom, environment: { ...drifted(), renderingDelta: [] } }))).toBe(false);
  });

  it('never drift when the DOM changed, styles changed or were not compared', () => {
    expect(isRenderingDrift(changed('a', { dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0 } }, environment: drifted() }))).toBe(false);
    expect(isRenderingDrift(changed('a', { dom: { ...sameDom, noiseHint: false, styleCheck: 'mismatch' }, environment: drifted() }))).toBe(false);
    expect(isRenderingDrift(changed('a', { dom: { ...sameDom, styleCheck: 'unavailable' }, environment: drifted() }))).toBe(false);
    expect(isRenderingDrift(changed('a', { environment: drifted() }))).toBe(false);
  });

  // A diff in one area is a bad capture or a change the style check does not
  // cover; a new browser or OS redraws text everywhere.
  it('never drift when the diff is concentrated in one area', () => {
    const regions = [{ x: 10, y: 10, width: 50, height: 20, diffPixels: 400, diffPercent: 40 }];
    expect(isRenderingDrift(changed('a', { regions, dom: sameDom, environment: drifted() }))).toBe(false);
  });

  it('a size change explained by the environment (viewport, device scale, capture method) is drift', () => {
    const sizeMismatch = { baseline: { width: 1280, height: 720 }, candidate: { width: 2560, height: 1440 } };
    expect(isRenderingDrift(changed('a', { sizeMismatch, dom: sameDom, environment: drifted(['render.deviceScaleFactor']) }))).toBe(true);
    // A size change the environment does not explain is about the page.
    expect(isRenderingDrift(changed('a', { sizeMismatch, dom: sameDom, environment: drifted(['browser.version']) }))).toBe(false);
  });

  it('a passed snapshot is drift only when it was auto-passed', () => {
    expect(isRenderingDrift({ ...changed('a', { dom: sameDom, environment: drifted() }), status: 'passed', autoPassed: 'noise' })).toBe(true);
    expect(isRenderingDrift({ ...changed('a', { dom: sameDom, environment: drifted() }), status: 'passed' })).toBe(false);
  });
});

describe('commonEnvironment', () => {
  it('is the fields every capture agrees on', () => {
    const firefox = bumped({ browser: { name: 'firefox', version: '143.0' }, project: 'firefox' });
    expect(commonEnvironment([baseline, firefox])).toEqual({
      os: baseline.os,
      framework: baseline.framework,
      adapter: baseline.adapter,
      render: baseline.render,
      ci: baseline.ci,
    });
  });

  it('one capture is its own environment; none is null', () => {
    expect(commonEnvironment([baseline])).toEqual(baseline);
    expect(commonEnvironment([])).toBeNull();
  });
});

describe('environmentChangeGroups', () => {
  const env = (version: string) => ({
    baseline,
    candidate: bumped({ browser: { ...baseline.browser, version } }),
    delta: ['browser.version'],
    renderingDelta: ['browser.version'],
  });

  it('groups changed snapshots by the same environment change, counting the drift among them', () => {
    const groups = environmentChangeGroups([
      changed('a', { dom: sameDom, environment: env('141.0.7390.37') }),
      changed('b', { dom: sameDom, environment: env('141.0.7390.37') }),
      changed('c', { dom: { changed: true, noiseHint: false, summary: { added: 1, removed: 0, attributeChanges: 0 } }, environment: env('141.0.7390.37') }),
      changed('d', { dom: sameDom, environment: env('142.0.1') }),
      changed('e', { dom: sameDom }),
      { name: 'f', status: 'passed', diffPercent: 0, diffCount: 0, totalPixels: 0, environment: env('141.0.7390.37') } as SnapshotResult,
    ]);
    expect(groups).toEqual([
      { change: 'chromium 130.0.6723.58 → 141.0.7390.37', snapshots: ['a', 'b', 'c'], drift: ['a', 'b'] },
      { change: 'chromium 130.0.6723.58 → 142.0.1', snapshots: ['d'], drift: ['d'] },
    ]);
  });

  it('nothing to group without environment changes', () => {
    expect(environmentChangeGroups([changed('a', { dom: sameDom })])).toEqual([]);
  });
});

// The run-level line: said once at the top when several snapshots share one
// environment change, with an honest count of how many are drift alone.
describe('environmentChangeLine', () => {
  const change = 'chromium 130.0.6723.58 → 141.0.7390.37';

  it('every snapshot is drift: they are not page changes', () => {
    expect(environmentChangeLine({ change, snapshots: ['a', 'b', 'c'], drift: ['a', 'b', 'c'] })).toBe(
      'Environment changed since the baselines (chromium 130.0.6723.58 → 141.0.7390.37): 3 diffs are rendering drift ' +
        '(DOM and computed styles identical), not page changes; re-baseline them once the images are confirmed.',
    );
  });

  it('some are drift, the rest have something else to review', () => {
    expect(environmentChangeLine({ change, snapshots: ['a', 'b', 'c'], drift: ['a', 'b'] })).toBe(
      'Environment changed since the baselines (chromium 130.0.6723.58 → 141.0.7390.37) for 3 snapshots: 2 are rendering drift ' +
        '(DOM and computed styles identical); 1 also has a change the environment does not explain, review it on its own.',
    );
  });

  it('none is drift alone', () => {
    expect(environmentChangeLine({ change, snapshots: ['a', 'b'], drift: [] })).toBe(
      'Environment changed since the baselines (chromium 130.0.6723.58 → 141.0.7390.37) for 2 snapshots; each also has a change ' +
        'the environment does not explain, so review them on their own.',
    );
  });
});
