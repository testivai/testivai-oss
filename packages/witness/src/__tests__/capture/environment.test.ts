/**
 * Capture provenance, collection side (capture/environment.ts): what every
 * adapter records about where a capture came from. Every source is injected,
 * so these run the same on any machine.
 */
import {
  applyEnvironmentPolicyToName,
  browserFromCapabilities,
  browserFromUserAgent,
  buildCaptureEnvironment,
  CAPTURE_METHODS,
  collectHostEnvironment,
  detectCi,
  distroFromOsRelease,
  installedPackageVersion,
  parseEnvironmentVariant,
  parseRenderProbe,
  readEnvironment,
  RENDER_PROBE_EXPRESSION,
} from '../../capture/environment';

const UBUNTU_OS_RELEASE = [
  'PRETTY_NAME="Ubuntu 24.04.5 LTS"',
  'NAME="Ubuntu"',
  'VERSION_ID="24.04"',
  'VERSION="24.04.5 LTS (Noble Numbat)"',
  'ID=ubuntu',
  'ID_LIKE=debian',
].join('\n');

describe('distroFromOsRelease', () => {
  it('reads ID and VERSION_ID: the distro and its release, the fields that decide the fonts', () => {
    expect(distroFromOsRelease(UBUNTU_OS_RELEASE)).toBe('ubuntu 24.04');
  });

  it('handles unquoted values and a rolling distro without VERSION_ID', () => {
    expect(distroFromOsRelease('ID=arch\nNAME="Arch Linux"\n')).toBe('arch');
    expect(distroFromOsRelease('ID=debian\nVERSION_ID=12\n')).toBe('debian 12');
  });

  it('is undefined without an ID', () => {
    expect(distroFromOsRelease('')).toBeUndefined();
    expect(distroFromOsRelease('NAME=whatever\n')).toBeUndefined();
  });
});

describe('detectCi', () => {
  it('GitHub Actions: provider and the runner image (ImageOS/ImageVersion)', () => {
    expect(detectCi({ GITHUB_ACTIONS: 'true', ImageOS: 'ubuntu24', ImageVersion: '20251012.1.0' })).toEqual({
      provider: 'github-actions',
      runnerImage: 'ubuntu24/20251012.1.0',
    });
    // A self-hosted runner or a container job has no image variables.
    expect(detectCi({ GITHUB_ACTIONS: 'true' })).toEqual({ provider: 'github-actions' });
  });

  it('names the other common providers, and a generic CI=true', () => {
    expect(detectCi({ GITLAB_CI: 'true' })).toEqual({ provider: 'gitlab' });
    expect(detectCi({ CIRCLECI: 'true' })).toEqual({ provider: 'circleci' });
    expect(detectCi({ BUILDKITE: 'true' })).toEqual({ provider: 'buildkite' });
    expect(detectCi({ JENKINS_URL: 'https://ci.example' })).toEqual({ provider: 'jenkins' });
    expect(detectCi({ TF_BUILD: 'True' })).toEqual({ provider: 'azure-pipelines' });
    expect(detectCi({ CI: 'true' })).toEqual({ provider: 'ci' });
  });

  it('is undefined outside CI, and CI=false does not count', () => {
    expect(detectCi({})).toBeUndefined();
    expect(detectCi({ CI: 'false' })).toBeUndefined();
  });
});

describe('collectHostEnvironment', () => {
  const base = {
    env: {},
    platform: 'linux',
    release: '6.8.0-1017-azure',
    arch: 'x64',
    readFile: (p: string) => (p === '/etc/os-release' ? UBUNTU_OS_RELEASE : null),
    exists: () => false,
  };

  it('records the OS, with the distro on Linux', () => {
    expect(collectHostEnvironment(base)).toEqual({
      os: { platform: 'linux', release: '6.8.0-1017-azure', arch: 'x64', distro: 'ubuntu 24.04' },
    });
  });

  it('no distro off Linux, even if a file happens to exist', () => {
    expect(collectHostEnvironment({ ...base, platform: 'darwin', release: '24.6.0', arch: 'arm64' })).toEqual({
      os: { platform: 'darwin', release: '24.6.0', arch: 'arm64' },
    });
  });

  it('adds CI, a container (/.dockerenv or /run/.containerenv) and TESTIVAI_ENV_LABEL when present', () => {
    const host = collectHostEnvironment({
      ...base,
      env: { GITHUB_ACTIONS: 'true', ImageOS: 'ubuntu24', ImageVersion: '20251012.1.0', TESTIVAI_ENV_LABEL: ' mcr.microsoft.com/playwright:v1.64.1-noble ' },
      exists: (p: string) => p === '/.dockerenv',
    });
    expect(host.ci).toEqual({ provider: 'github-actions', runnerImage: 'ubuntu24/20251012.1.0' });
    expect(host.container).toBe(true);
    expect(host.label).toBe('mcr.microsoft.com/playwright:v1.64.1-noble');
    expect(collectHostEnvironment({ ...base, exists: (p: string) => p === '/run/.containerenv' }).container).toBe(true);
  });

  it('an empty label is no label', () => {
    expect(collectHostEnvironment({ ...base, env: { TESTIVAI_ENV_LABEL: '  ' } }).label).toBeUndefined();
  });

  it('never throws when a source does', () => {
    const host = collectHostEnvironment({
      ...base,
      readFile: () => {
        throw new Error('EACCES');
      },
      exists: () => {
        throw new Error('EACCES');
      },
    });
    expect(host.os).toEqual({ platform: 'linux', release: '6.8.0-1017-azure', arch: 'x64' });
    expect(host.container).toBeUndefined();
  });

  it('defaults to the real process and os module', () => {
    const host = collectHostEnvironment();
    expect(host.os.platform).toBe(process.platform);
    expect(typeof host.os.release).toBe('string');
    expect(typeof host.os.arch).toBe('string');
  });
});

describe('browserFromUserAgent', () => {
  it('reads Chrome, headless Chrome, Edge, Firefox and Safari', () => {
    expect(
      browserFromUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36'),
    ).toEqual({ name: 'chromium', version: '141.0.7390.37', headless: true });
    expect(
      browserFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.37 Safari/537.36'),
    ).toEqual({ name: 'chromium', version: '141.0.7390.37' });
    expect(
      browserFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57'),
    ).toEqual({ name: 'chromium', version: '141.0.0.0', channel: 'msedge' });
    expect(browserFromUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0')).toEqual({
      name: 'firefox',
      version: '143.0',
    });
    expect(
      browserFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'),
    ).toEqual({ name: 'webkit', version: '26.0' });
  });

  it('is null for anything else', () => {
    expect(browserFromUserAgent('curl/8.5.0')).toBeNull();
    expect(browserFromUserAgent('')).toBeNull();
    expect(browserFromUserAgent('SomeTool Version/2.1')).toBeNull();
  });

  it('runs in linear time on a user agent with a long run of dots (no regex backtracking)', () => {
    // A user agent comes from the page under test. "Version/" followed by
    // 100k dots and no "Safari/" took seconds with a backtracking pattern.
    const ua = `Version/${'.'.repeat(100_000)}`;
    const start = performance.now();
    expect(browserFromUserAgent(ua)).toBeNull();
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe('RENDER_PROBE_EXPRESSION and parseRenderProbe', () => {
  it('the probe is one self-contained expression that runs without the page having anything', () => {
    // Evaluate it against a fake window: no imports, no closures.
    const fakeWindow = {
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 2,
      matchMedia: (q: string) => ({ matches: q === '(prefers-color-scheme: dark)' }),
      navigator: { language: 'en-GB', userAgent: 'UA' },
      Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) },
    };
    const run = new Function('window', 'navigator', 'Intl', `return (${RENDER_PROBE_EXPRESSION});`);
    const raw = run(fakeWindow, fakeWindow.navigator, fakeWindow.Intl);
    expect(parseRenderProbe(raw)).toEqual({
      render: {
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
        colorScheme: 'dark',
        reducedMotion: 'no-preference',
        locale: 'en-GB',
        timezone: 'Europe/London',
      },
      userAgent: 'UA',
    });
  });

  it('drops mistyped fields instead of trusting them, and is null for a non-object', () => {
    expect(parseRenderProbe({ viewport: { width: '1280', height: 720 }, deviceScaleFactor: 'x', locale: 5, colorScheme: 'blue' })).toEqual({
      render: {},
    });
    expect(parseRenderProbe(null)).toBeNull();
    expect(parseRenderProbe('nope')).toBeNull();
  });
});

describe('buildCaptureEnvironment', () => {
  const host = { os: { platform: 'linux', release: '6.8.0', arch: 'x64', distro: 'ubuntu 24.04' } };

  it('assembles the block and leaves out every part an adapter did not provide', () => {
    expect(
      buildCaptureEnvironment({
        host,
        browser: { name: 'chromium', version: '141.0.7390.37', headless: true },
        adapter: { name: '@testivai/witness', version: '2.3.0', captureMethod: CAPTURE_METHODS.CDP_FULL_PAGE },
      }),
    ).toEqual({
      os: { platform: 'linux', release: '6.8.0', arch: 'x64', distro: 'ubuntu 24.04' },
      browser: { name: 'chromium', version: '141.0.7390.37', headless: true },
      adapter: { name: '@testivai/witness', version: '2.3.0', captureMethod: 'full-page:cdp' },
    });
  });

  it('keeps framework, driver, render and project when given, dropping undefined members', () => {
    const env = buildCaptureEnvironment({
      host: { ...host, ci: { provider: 'github-actions' }, container: true, label: 'pw-1.64' },
      browser: { name: 'chromium', version: null, channel: undefined },
      framework: { name: 'playwright', version: '1.64.1', language: 'typescript', runner: '@playwright/test' },
      adapter: { name: '@testivai/witness-playwright', version: '2.0.7', captureMethod: CAPTURE_METHODS.PLAYWRIGHT_FULL_PAGE },
      driver: { name: 'chromedriver', version: '141.0.7390.37' },
      render: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: undefined },
      project: 'chromium',
    });
    expect(env.browser).toEqual({ name: 'chromium', version: null });
    expect(env.render).toEqual({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    expect(env).toMatchObject({ ci: { provider: 'github-actions' }, container: true, label: 'pw-1.64', project: 'chromium' });
    expect(Object.keys(env)).not.toContain('undefined');
    expect(JSON.parse(JSON.stringify(env))).toEqual(env);
  });
});

describe('readEnvironment', () => {
  const valid = {
    os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
    browser: { name: 'chromium', version: '141.0.7390.37' },
    adapter: { name: '@testivai/witness', version: '2.3.0', captureMethod: 'full-page:cdp' },
  };

  it('accepts a recorded block', () => {
    expect(readEnvironment(valid)).toEqual(valid);
  });

  it('is null for anything without the three required parts (older or foreign metadata)', () => {
    expect(readEnvironment(undefined)).toBeNull();
    expect(readEnvironment({})).toBeNull();
    expect(readEnvironment({ ...valid, os: 'linux' })).toBeNull();
    expect(readEnvironment({ ...valid, adapter: { name: 'x' } })).toBeNull();
    expect(readEnvironment({ ...valid, browser: { version: '1' } })).toBeNull();
  });
});

describe('separate policy keying', () => {
  const env = { browser: { name: 'chromium' }, os: { platform: 'linux' } };

  it('separate keys a snapshot as <name>__<browser>__<platform>', () => {
    expect(applyEnvironmentPolicyToName('home', env, 'separate')).toBe('home__chromium__linux');
  });

  it('does not repeat a browser already in the name (a Playwright project named after it)', () => {
    expect(applyEnvironmentPolicyToName('home__chromium', env, 'separate')).toBe('home__chromium__linux');
    expect(applyEnvironmentPolicyToName('home__mobile-chrome', env, 'separate')).toBe('home__mobile-chrome__chromium__linux');
  });

  it('warn and strict, or no policy, never touch the name', () => {
    expect(applyEnvironmentPolicyToName('home', env, 'warn')).toBe('home');
    expect(applyEnvironmentPolicyToName('home', env, 'strict')).toBe('home');
    expect(applyEnvironmentPolicyToName('home', env, undefined)).toBe('home');
  });

  it('never keys by version, and sanitizes names', () => {
    expect(applyEnvironmentPolicyToName('home', { browser: { name: 'Microsoft Edge' }, os: { platform: 'win32' } }, 'separate')).toBe(
      'home__microsoft_edge__win32',
    );
  });

  it('parseEnvironmentVariant reads the suffix back, only with a known platform', () => {
    expect(parseEnvironmentVariant('home__chromium__linux')).toEqual({ base: 'home', browser: 'chromium', platform: 'linux' });
    expect(parseEnvironmentVariant('home__mobile-chrome__chromium__darwin')).toEqual({
      base: 'home__mobile-chrome',
      browser: 'chromium',
      platform: 'darwin',
    });
    expect(parseEnvironmentVariant('home__chromium')).toBeNull();
    expect(parseEnvironmentVariant('home__a__b')).toBeNull();
  });
});

describe('browserFromCapabilities (WebDriver: WebdriverIO and Selenium)', () => {
  it('Chrome: chromium with channel chrome, headless from its args, and chromedriver', () => {
    expect(
      browserFromCapabilities({
        browserName: 'chrome',
        browserVersion: '141.0.7390.37',
        'goog:chromeOptions': { args: ['--headless=new', '--no-sandbox'] },
        chrome: { chromedriverVersion: '141.0.7390.37 (2b1b84a5a9f6c7e7a9b7e3a0b8c9d1e2f3a4b5c6-refs/branch-heads/7390@{#1})' },
      }),
    ).toEqual({
      browser: { name: 'chromium', version: '141.0.7390.37', channel: 'chrome', headless: true },
      driver: { name: 'chromedriver', version: '141.0.7390.37' },
    });
  });

  it('Edge, Firefox and Safari', () => {
    expect(browserFromCapabilities({ browserName: 'MicrosoftEdge', browserVersion: '141.0.3537.57', msedge: { msedgedriverVersion: '141.0.3537.57 (abc)' } })).toEqual({
      browser: { name: 'chromium', version: '141.0.3537.57', channel: 'msedge' },
      driver: { name: 'msedgedriver', version: '141.0.3537.57' },
    });
    expect(
      browserFromCapabilities({ browserName: 'firefox', browserVersion: '143.0', 'moz:firefoxOptions': { args: ['-headless'] }, 'moz:geckodriverVersion': '0.36.0' }),
    ).toEqual({ browser: { name: 'firefox', version: '143.0', headless: true }, driver: { name: 'geckodriver', version: '0.36.0' } });
    expect(browserFromCapabilities({ browserName: 'Safari', browserVersion: '26.0' })).toEqual({
      browser: { name: 'webkit', version: '26.0', channel: 'safari' },
    });
  });

  it('reads a selenium-webdriver Capabilities object through get()', () => {
    const map = new Map<string, unknown>([
      ['browserName', 'chrome'],
      ['browserVersion', '141.0.7390.37'],
    ]);
    expect(browserFromCapabilities({ get: (k: string) => map.get(k) })).toEqual({
      browser: { name: 'chromium', version: '141.0.7390.37', channel: 'chrome' },
    });
  });

  it('a non-headless run says headless: false only when the options are there to say so', () => {
    expect(browserFromCapabilities({ browserName: 'chrome', browserVersion: '1', 'goog:chromeOptions': { args: [] } })?.browser.headless).toBe(false);
    expect(browserFromCapabilities({ browserName: 'chrome', browserVersion: '1' })?.browser.headless).toBeUndefined();
  });

  it('is null without a browser name; an unknown browser keeps its lowercased name', () => {
    expect(browserFromCapabilities({})).toBeNull();
    expect(browserFromCapabilities(null)).toBeNull();
    expect(browserFromCapabilities({ browserName: 'Servo', browserVersion: '0.1' })).toEqual({ browser: { name: 'servo', version: '0.1' } });
  });
});

describe('installedPackageVersion', () => {
  it('the version of a package as the project at that root resolves it', () => {
    const expected = require('pngjs/package.json').version;
    expect(installedPackageVersion('pngjs', require('path').join(__dirname, '..', '..', '..'))).toBe(expected);
  });

  it('null for a package the project does not have', () => {
    expect(installedPackageVersion('definitely-not-installed-testivai-pkg', process.cwd())).toBeNull();
  });
});
