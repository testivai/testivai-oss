import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { witness } from '../witness';
import type { WitnessBrowser } from '../types';

/**
 * 1x1 transparent PNG, base64 encoded — small but valid enough for
 * "browser.takeScreenshot returned a real-looking string" assertions.
 */
const ONE_PX_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

describe('witness()', () => {
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-wdio-witness-'));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function makeBrowser(overrides: Partial<WitnessBrowser> = {}): WitnessBrowser {
    return {
      takeScreenshot: jest.fn().mockResolvedValue(ONE_PX_PNG_B64),
      execute: jest.fn().mockResolvedValue('<html><body><h1>Hi</h1></body></html>'),
      ...overrides,
    };
  }

  it('writes screenshot.png and dom.html under .testivai/temp/<name>/', async () => {
    await witness(makeBrowser(), 'homepage');

    const tempDir = path.join(projectRoot, '.testivai', 'temp', 'homepage');
    expect(fs.existsSync(path.join(tempDir, 'screenshot.png'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'dom.html'))).toBe(true);

    const dom = fs.readFileSync(path.join(tempDir, 'dom.html'), 'utf-8');
    expect(dom).toContain('<h1>Hi</h1>');

    const png = fs.readFileSync(path.join(tempDir, 'screenshot.png'));
    expect(png.length).toBeGreaterThan(0);
  });

  it('decodes the base64 screenshot into a real PNG buffer', async () => {
    const browser = makeBrowser();
    await witness(browser, 'snap');

    const png = fs.readFileSync(
      path.join(projectRoot, '.testivai', 'temp', 'snap', 'screenshot.png'),
    );
    // PNG magic header: 89 50 4E 47 0D 0A 1A 0A
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
  });

  it('skips DOM capture when skipDom: true', async () => {
    const browser = makeBrowser();
    await witness(browser, 'no-dom', { skipDom: true });

    const tempDir = path.join(projectRoot, '.testivai', 'temp', 'no-dom');
    expect(fs.existsSync(path.join(tempDir, 'screenshot.png'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'dom.html'))).toBe(false);
    // execute() is still used for capture stabilization — but never for DOM
    const domCalls = (browser.execute as jest.Mock).mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('outerHTML'),
    );
    expect(domCalls).toHaveLength(0);
  });

  it('omits dom.html when browser.execute is missing', async () => {
    const browser: WitnessBrowser = {
      takeScreenshot: jest.fn().mockResolvedValue(ONE_PX_PNG_B64),
      // execute deliberately omitted
    } as unknown as WitnessBrowser;
    await witness(browser, 'no-execute');

    const tempDir = path.join(projectRoot, '.testivai', 'temp', 'no-execute');
    expect(fs.existsSync(path.join(tempDir, 'screenshot.png'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'dom.html'))).toBe(false);
  });

  it('omits dom.html when DOM capture throws (best-effort)', async () => {
    const browser = makeBrowser({
      execute: jest.fn().mockRejectedValue(new Error('DOM serialization timed out')),
    });
    await witness(browser, 'flaky-dom');

    const tempDir = path.join(projectRoot, '.testivai', 'temp', 'flaky-dom');
    expect(fs.existsSync(path.join(tempDir, 'screenshot.png'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'dom.html'))).toBe(false);
  });

  it('omits dom.html when execute returns empty/non-string', async () => {
    const browser = makeBrowser({
      execute: jest.fn().mockResolvedValue(''),
    });
    await witness(browser, 'empty-dom');

    const tempDir = path.join(projectRoot, '.testivai', 'temp', 'empty-dom');
    expect(fs.existsSync(path.join(tempDir, 'screenshot.png'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'dom.html'))).toBe(false);
  });

  it('rejects empty/missing snapshot name', async () => {
    await expect(witness(makeBrowser(), '')).rejects.toThrow(/name is required/);
    // @ts-expect-error - intentional bad call
    await expect(witness(makeBrowser(), undefined)).rejects.toThrow(/name is required/);
  });

  it('rejects browser without takeScreenshot', async () => {
    // @ts-expect-error - intentional bad call
    await expect(witness({}, 'name')).rejects.toThrow(/takeScreenshot/);
  });

  it('throws a clear error when takeScreenshot returns an empty string', async () => {
    const browser = makeBrowser({
      takeScreenshot: jest.fn().mockResolvedValue(''),
    });
    await expect(witness(browser, 'no-pixels')).rejects.toThrow(
      /returned an empty value/,
    );
  });

  describe('variant keying', () => {
    it('folds the variant into the snapshot name (sanitized)', async () => {
      await witness(makeBrowser(), 'homepage', { variant: 'Firefox Mobile @2x' });
      const tempDir = path.join(projectRoot, '.testivai', 'temp', 'homepage__firefox_mobile_2x');
      expect(fs.existsSync(path.join(tempDir, 'screenshot.png'))).toBe(true);
    });

    it('different variants never collide', async () => {
      await witness(makeBrowser(), 'homepage', { variant: 'chrome' });
      await witness(makeBrowser(), 'homepage', { variant: 'firefox' });
      const base = path.join(projectRoot, '.testivai', 'temp');
      expect(fs.existsSync(path.join(base, 'homepage__chrome', 'screenshot.png'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'homepage__firefox', 'screenshot.png'))).toBe(true);
    });
  });

  describe('capture preparation (stabilize + ignoreSelectors)', () => {
    const executedScripts = (browser: WitnessBrowser): string[] =>
      (browser.execute as jest.Mock).mock.calls
        .map((c) => c[0])
        .filter((s): s is string => typeof s === 'string');

    const writeConfig = (config: object) => {
      fs.mkdirSync(path.join(projectRoot, '.testivai'), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, '.testivai', 'config.json'),
        JSON.stringify(config),
      );
    };

    it('injects stabilization CSS by default and removes it after capture', async () => {
      const browser = makeBrowser();
      await witness(browser, 'stable');

      const scripts = executedScripts(browser);
      expect(scripts.some((s) => s.includes('animation-duration: 0.001s'))).toBe(true);
      expect(scripts.some((s) => s.includes('caret-color: transparent'))).toBe(true);
      expect(scripts.some((s) => s.includes('el.remove()'))).toBe(true);
    });

    it('waits on document.fonts before the screenshot', async () => {
      const browser = makeBrowser();
      await witness(browser, 'fonts');

      const scripts = executedScripts(browser);
      expect(scripts.some((s) => s.includes('document.fonts'))).toBe(true);
    });

    it('merges ignoreSelectors from config.json and per-call options', async () => {
      writeConfig({ mode: 'local', ignoreSelectors: ['.from-config'] });
      const browser = makeBrowser();
      await witness(browser, 'ignored', { ignoreSelectors: ['.from-call'] });

      const injected = executedScripts(browser).find((s) => s.includes('visibility: hidden'));
      expect(injected).toBeDefined();
      expect(injected).toContain('.from-config');
      expect(injected).toContain('.from-call');
    });

    it('honors stabilize: false from config.json (no CSS injected)', async () => {
      writeConfig({ mode: 'local', stabilize: false });
      const browser = makeBrowser();
      await witness(browser, 'raw');

      const scripts = executedScripts(browser);
      expect(scripts.some((s) => s.includes('animation-duration'))).toBe(false);
      // no style tag injected — the DOM-capture script legitimately contains
      // element removal (ignoreSelectors exclusion), so target the style id
      expect(scripts.some((s) => s.includes('__testivai_capture_css__'))).toBe(false);
    });

    it('per-call stabilize: false wins over config default', async () => {
      const browser = makeBrowser();
      await witness(browser, 'raw-call', { stabilize: false });

      const scripts = executedScripts(browser);
      expect(scripts.some((s) => s.includes('animation-duration'))).toBe(false);
    });

    it('removes the injected CSS even when the screenshot throws', async () => {
      const browser = makeBrowser({
        takeScreenshot: jest.fn().mockRejectedValue(new Error('boom')),
      });
      await expect(witness(browser, 'explodes')).rejects.toThrow('boom');

      const scripts = executedScripts(browser);
      expect(scripts.some((s) => s.includes('__testivai_capture_css__') && s.includes('remove'))).toBe(true);
    });
  });
});

/**
 * Capture provenance: witness() records where the capture came from in the
 * capture's metadata.json, from the session's capabilities and the in-page
 * render probe. WebDriver's takeScreenshot covers the viewport only.
 */
describe('witness() capture provenance', () => {
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-wdio-env-'));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const PROBE = {
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    locale: 'en-US',
    timezone: 'UTC',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.37 Safari/537.36',
  };

  /** A browser that answers the render probe and returns the DOM otherwise. */
  function browserWith(capabilities?: Record<string, unknown>): WitnessBrowser {
    return {
      takeScreenshot: jest.fn().mockResolvedValue(ONE_PX_PNG_B64),
      execute: jest.fn(async (script: unknown) =>
        typeof script === 'string' && script.includes('prefers-color-scheme') ? PROBE : '<html><body><h1>Hi</h1></body></html>',
      ) as unknown as WitnessBrowser['execute'],
      ...(capabilities ? { capabilities } : {}),
    };
  }

  const metadata = (name: string) =>
    JSON.parse(fs.readFileSync(path.join(projectRoot, '.testivai', 'temp', name, 'metadata.json'), 'utf-8'));

  it('records the browser and driver from the capabilities, the adapter, the viewport capture method and the render probe', async () => {
    await witness(
      browserWith({
        browserName: 'chrome',
        browserVersion: '141.0.7390.37',
        'goog:chromeOptions': { args: ['--headless=new'] },
        chrome: { chromedriverVersion: '141.0.7390.37 (abc-refs/branch-heads/7390@{#1})' },
      }),
      'home',
    );
    const { environment } = metadata('home');
    expect(environment).toMatchObject({
      os: { platform: process.platform },
      browser: { name: 'chromium', version: '141.0.7390.37', channel: 'chrome', headless: true },
      framework: { name: 'webdriverio' },
      adapter: { name: '@testivai/witness-webdriverio', captureMethod: 'viewport:webdriver' },
      driver: { name: 'chromedriver', version: '141.0.7390.37' },
      render: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-US', timezone: 'UTC' },
    });
    expect(environment.adapter.version).toMatch(/^\d+\.\d+\.\d+/);
    // The project's own webdriverio, or null when it cannot be resolved: never guessed.
    expect(environment.framework.version === null || typeof environment.framework.version === 'string').toBe(true);
  });

  it('without capabilities, the browser comes from the probe\'s user agent', async () => {
    await witness(browserWith(), 'home');
    expect(metadata('home').environment.browser).toEqual({ name: 'chromium', version: '141.0.7390.37' });
  });

  it('environmentPolicy "separate" keys the snapshot <name>__<browser>__<platform>', async () => {
    fs.mkdirSync(path.join(projectRoot, '.testivai'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.testivai', 'config.json'), JSON.stringify({ environmentPolicy: 'separate' }));
    await witness(browserWith({ browserName: 'firefox', browserVersion: '143.0' }), 'home');
    expect(fs.existsSync(path.join(projectRoot, '.testivai', 'temp', `home__firefox__${process.platform}`, 'screenshot.png'))).toBe(true);
  });
});
