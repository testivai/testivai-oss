/**
 * Capture provenance for the Playwright adapter: what witness() records in
 * the capture's metadata.json. The sources (testInfo, the browser, the
 * in-page probe) are passed in, so this needs no browser.
 */
import { CAPTURE_METHODS, type HostEnvironment } from '@testivai/witness';
import { playwrightBrowserName, playwrightEnvironment } from '../../capture/environment';

const host: HostEnvironment = { os: { platform: 'linux', release: '6.8.0', arch: 'x64', distro: 'ubuntu 24.04' } };
const HEADLESS_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36';

const testInfo = (use: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  config: { version: '1.64.1' },
  project: { name: 'chromium', use },
  file: '/repo/tests/home.spec.ts',
  ...extra,
});

const probe = {
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  reducedMotion: 'no-preference',
  locale: 'en-US',
  timezone: 'UTC',
  userAgent: HEADLESS_UA,
};

describe('playwrightEnvironment', () => {
  it('records the browser, Playwright, the adapter and capture method, the measured render settings and the project', () => {
    const env = playwrightEnvironment({
      testInfo: testInfo({ browserName: 'chromium', headless: true }),
      browserVersion: '141.0.7390.37',
      probe,
      captureMethod: CAPTURE_METHODS.CDP_FULL_PAGE,
      host,
    });
    expect(env).toEqual({
      os: host.os,
      browser: { name: 'chromium', version: '141.0.7390.37', headless: true },
      framework: { name: 'playwright', version: '1.64.1', language: 'typescript', runner: '@playwright/test' },
      adapter: { name: '@testivai/witness-playwright', version: expect.stringMatching(/^\d+\.\d+\.\d+/), captureMethod: 'full-page:cdp' },
      render: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'no-preference', locale: 'en-US', timezone: 'UTC' },
      project: 'chromium',
    });
  });

  it('records the channel from the project, and a JavaScript test file as javascript', () => {
    const env = playwrightEnvironment({
      testInfo: testInfo({ browserName: 'chromium', channel: 'chrome', headless: false }, { file: '/repo/tests/home.spec.js' }),
      browserVersion: '141.0.7390.37',
      probe,
      captureMethod: CAPTURE_METHODS.CDP_FULL_PAGE,
      host,
    });
    expect(env.browser).toEqual({ name: 'chromium', version: '141.0.7390.37', channel: 'chrome', headless: false });
    expect(env.framework?.language).toBe('javascript');
  });

  // A persistent context has no browser() to ask for its version: the user
  // agent is the fallback, and its headless marker too.
  it('without a browser version, reads it from the user agent', () => {
    const env = playwrightEnvironment({ testInfo: testInfo(), browserVersion: null, probe, captureMethod: CAPTURE_METHODS.PLAYWRIGHT_FULL_PAGE, host });
    expect(env.browser).toEqual({ name: 'chromium', version: '141.0.7390.37', headless: true });
  });

  it('without a version or a usable probe, the version is null, never guessed', () => {
    const env = playwrightEnvironment({ testInfo: testInfo({ browserName: 'firefox' }), browserVersion: null, probe: null, captureMethod: CAPTURE_METHODS.PLAYWRIGHT_FULL_PAGE, host });
    expect(env.browser).toEqual({ name: 'firefox', version: null });
    expect(env.render).toBeUndefined();
  });

  it('a single unnamed project records no project; a missing Playwright version is null', () => {
    const env = playwrightEnvironment({
      testInfo: { config: {}, project: { name: '', use: {} }, file: '/x.spec.ts' },
      browserVersion: '1',
      probe,
      captureMethod: CAPTURE_METHODS.CDP_FULL_PAGE,
      host,
    });
    expect(env.project).toBeUndefined();
    expect(env.framework?.version).toBeNull();
  });
});

describe('playwrightBrowserName', () => {
  it('the project browserName wins, then the user agent, then chromium (Playwright\'s default)', () => {
    expect(playwrightBrowserName(testInfo({ browserName: 'webkit' }), HEADLESS_UA)).toBe('webkit');
    expect(playwrightBrowserName(testInfo(), 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0')).toBe('firefox');
    expect(playwrightBrowserName(testInfo(), undefined)).toBe('chromium');
  });
});
