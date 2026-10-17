import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { witness } from '../witness';
import type { WitnessDriver } from '../types';

/**
 * 1x1 transparent PNG, base64 encoded — small but valid enough for
 * "driver returned a real-looking PNG" assertions.
 */
const ONE_PX_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

/** A fake driver whose executeScript understands the adapter's scripts. */
function makeDriver(overrides: Partial<WitnessDriver> & { dom?: string } = {}) {
  const injectedCss: string[] = [];
  const state = { styleRemoved: false };
  const dom = overrides.dom ?? '<html><body><h1>Hi</h1></body></html>';

  const executeScript = jest.fn(async (script: string, ...args: unknown[]) => {
    if (script.includes("createElement('style')")) {
      injectedCss.push(String(args[1]));
      return undefined;
    }
    if (script.includes('getElementById') && script.includes('remove')) {
      state.styleRemoved = true;
      return undefined;
    }
    if (script.includes('document.fonts')) {
      return true;
    }
    if (script.includes('settleProbe') || script.includes('__testivaiSettleState')) {
      // A real browser answers the probe; settled so tests don't wait.
      return { ready: true, imagesPending: 0, fontsPending: false, quietFor: 999, settled: true };
    }
    if (script.includes('collectElementMap')) {
      // Evaluate the real injected expression against a duck-typed DOM,
      // so the test proves the adapter ships a runnable script — not just
      // that it called executeScript.
      const rect = { x: 0, y: 0, width: 100, height: 40 };
      const makeEl = (tag: string): Record<string, unknown> => ({
        tagName: tag.toUpperCase(),
        classList: { length: 0 },
        children: [] as unknown[],
        parentElement: null,
        getBoundingClientRect: () => rect,
        matches: () => false,
      });
      const body = makeEl('body');
      const h1 = makeEl('h1');
      (h1 as { parentElement: unknown }).parentElement = body;
      (body as { children: unknown[] }).children = [h1];
      const doc = { body };
      const win = {
        devicePixelRatio: 1,
        scrollX: 0,
        scrollY: 0,
        getComputedStyle: () => ({ getPropertyValue: () => 'x' }),
      };
      // strip the leading `return ` the adapter adds for Selenium
      const expr = script.replace(/^return /, '');
      // eslint-disable-next-line no-new-func
      const fn = new Function('document', 'window', `return ${expr};`);
      return fn(doc, win);
    }
    if (script.includes('prefers-color-scheme')) {
      // The render probe: run the real expression against a fake window.
      const win = {
        innerWidth: 1366,
        innerHeight: 768,
        devicePixelRatio: 1,
        matchMedia: () => ({ matches: false }),
      };
      const nav = { language: 'de-DE', userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0' };
      const intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/Berlin' }) }) };
      // eslint-disable-next-line no-new-func
      // The adapter sends 'return ' + the probe expression: a valid function body as is.
      return new Function('window', 'navigator', 'Intl', script)(win, nav, intl);
    }
    if (script.includes('cloneNode')) {
      let result = dom;
      for (const sel of (args[0] as string[]) ?? []) {
        result = result.replace(`<div class="${sel.replace(/^\./, '')}">SECRET</div>`, '');
      }
      return result;
    }
    return undefined;
  });

  const driver: WitnessDriver = {
    takeScreenshot: jest.fn().mockResolvedValue(ONE_PX_PNG_B64),
    executeScript: executeScript as WitnessDriver['executeScript'],
    ...overrides,
  };
  return { driver, injectedCss, state, executeScript };
}

describe('witness()', () => {
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-selenium-witness-'));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    const dir = path.join(projectRoot, '.testivai');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'local', ...config }));
  }

  it('writes screenshot.png and dom.html under .testivai/temp/<name>/', async () => {
    const { driver } = makeDriver();
    await witness(driver, 'homepage');

    const tempDir = path.join(projectRoot, '.testivai', 'temp', 'homepage');
    const png = fs.readFileSync(path.join(tempDir, 'screenshot.png'));
    expect(png[0]).toBe(0x89); // PNG magic
    expect(fs.readFileSync(path.join(tempDir, 'dom.html'), 'utf-8')).toContain('<h1>Hi</h1>');
  });

  it('uses CDP full-page capture when the driver exposes it', async () => {
    const cdp = jest
      .fn()
      .mockResolvedValue({ data: ONE_PX_PNG_B64 });
    const { driver } = makeDriver({ sendAndGetDevToolsCommand: cdp });

    await witness(driver, 'full');

    expect(cdp).toHaveBeenCalledWith('Page.captureScreenshot', {
      captureBeyondViewport: true,
      format: 'png',
    });
    expect(driver.takeScreenshot).not.toHaveBeenCalled();
    const png = fs.readFileSync(path.join(projectRoot, '.testivai', 'temp', 'full', 'screenshot.png'));
    expect(png[0]).toBe(0x89);
  });

  it('falls back to viewport screenshot when CDP fails', async () => {
    const cdp = jest.fn().mockRejectedValue(new Error('cdp boom'));
    const { driver } = makeDriver({ sendAndGetDevToolsCommand: cdp });

    await witness(driver, 'fallback');

    expect(driver.takeScreenshot).toHaveBeenCalled();
    expect(
      fs.existsSync(path.join(projectRoot, '.testivai', 'temp', 'fallback', 'screenshot.png')),
    ).toBe(true);
  });

  it('injects stabilization CSS and removes it after the capture', async () => {
    const { driver, injectedCss, state } = makeDriver();
    await witness(driver, 'stab');

    expect(injectedCss.join('\n')).toContain('animation-duration: 0.001s');
    expect(state.styleRemoved).toBe(true);
  });

  it('skips stabilization when config disables it', async () => {
    writeConfig({ stabilize: false });
    const { driver, injectedCss } = makeDriver();
    await witness(driver, 'nostab');
    expect(injectedCss).toEqual([]);
  });

  it('per-call stabilize override wins over config', async () => {
    writeConfig({ stabilize: true });
    const { driver, injectedCss } = makeDriver();
    await witness(driver, 'x', { stabilize: false });
    expect(injectedCss).toEqual([]);
  });

  it('merges config and per-call ignoreSelectors into CSS and DOM exclusion', async () => {
    writeConfig({ ignoreSelectors: ['.from-config'] });
    const { driver, injectedCss, executeScript } = makeDriver({
      dom: '<html><body><div class="badge">SECRET</div><h1>Hi</h1></body></html>',
    });

    await witness(driver, 'ignored', { ignoreSelectors: ['.badge'] });

    const css = injectedCss.join('\n');
    expect(css).toContain('.from-config { visibility: hidden !important; }');
    expect(css).toContain('.badge { visibility: hidden !important; }');

    const domCall = executeScript.mock.calls.find(([s]) => (s as string).includes('cloneNode'));
    expect(domCall?.[1]).toEqual(['.from-config', '.badge']);

    const dom = fs.readFileSync(
      path.join(projectRoot, '.testivai', 'temp', 'ignored', 'dom.html'),
      'utf-8',
    );
    expect(dom).not.toContain('SECRET');
  });

  it('folds variant into the snapshot name', async () => {
    const { driver } = makeDriver();
    await witness(driver, 'homepage', { variant: 'Firefox 128 @2x' });
    expect(
      fs.existsSync(path.join(projectRoot, '.testivai', 'temp', 'homepage__firefox_128_2x')),
    ).toBe(true);
  });

  it('skipDom leaves no dom.html', async () => {
    const { driver } = makeDriver();
    await witness(driver, 'nodom', { skipDom: true });
    const tempDir = path.join(projectRoot, '.testivai', 'temp', 'nodom');
    expect(fs.existsSync(path.join(tempDir, 'screenshot.png'))).toBe(true);
    expect(fs.existsSync(path.join(tempDir, 'dom.html'))).toBe(false);
  });

  it('removes the style tag even when the screenshot fails', async () => {
    const { driver, state } = makeDriver({
      takeScreenshot: jest.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(witness(driver, 'explodes')).rejects.toThrow('boom');
    expect(state.styleRemoved).toBe(true);
  });

  it('rejects an empty snapshot name', async () => {
    const { driver } = makeDriver();
    await expect(witness(driver, '')).rejects.toThrow(/snapshot name/);
  });

  it('rejects a driver without takeScreenshot', async () => {
    await expect(witness({} as WitnessDriver, 'x')).rejects.toThrow(/takeScreenshot/);
  });

  it('throws when takeScreenshot returns an empty value', async () => {
    const { driver } = makeDriver({
      takeScreenshot: jest.fn().mockResolvedValue(''),
    });
    await expect(witness(driver, 'empty')).rejects.toThrow(/empty value/);
  });
});

describe('element map capture', () => {
  it('writes elements.json with selector paths and style hashes', async () => {
    const { driver } = makeDriver();
    await witness(driver, 'with-map');

    const p = path.join(process.cwd(), '.testivai', 'temp', 'with-map', 'elements.json');
    expect(fs.existsSync(p)).toBe(true);

    const map = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(Array.isArray(map)).toBe(true);
    expect(map.length).toBeGreaterThan(0);
    // the shape the compare side (readElementMap) expects
    for (const entry of map) {
      expect(typeof entry.path).toBe('string');
      expect(typeof entry.x).toBe('number');
      expect(typeof entry.y).toBe('number');
      expect(typeof entry.width).toBe('number');
      expect(typeof entry.height).toBe('number');
      expect(typeof entry.styleHash).toBe('string');
    }
  });

  it('skips the map when skipElementMap is set', async () => {
    const { driver } = makeDriver();
    await witness(driver, 'no-map', { skipElementMap: true });
    const p = path.join(process.cwd(), '.testivai', 'temp', 'no-map', 'elements.json');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('still writes screenshot + dom when the map script throws', async () => {
    const { driver } = makeDriver();
    const original = driver.executeScript as jest.Mock;
    (driver as { executeScript: unknown }).executeScript = jest.fn(
      async (script: string, ...args: unknown[]) => {
        if (script.includes('collectElementMap')) throw new Error('CSP blocked');
        return original(script, ...args);
      },
    );

    await witness(driver, 'map-fails');
    const dir = path.join(process.cwd(), '.testivai', 'temp', 'map-fails');
    expect(fs.existsSync(path.join(dir, 'screenshot.png'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'elements.json'))).toBe(false);
  });
});

/**
 * Capture provenance: witness() records where the capture came from in the
 * capture's metadata.json: the session's capabilities, the in-page render
 * probe, and which path took the screenshot (CDP full page on Chromium,
 * WebDriver's viewport screenshot elsewhere).
 */
describe('witness() capture provenance', () => {
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-selenium-env-'));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const metadata = (name: string) =>
    JSON.parse(fs.readFileSync(path.join(projectRoot, '.testivai', 'temp', name, 'metadata.json'), 'utf-8'));

  /** selenium-webdriver's Capabilities: read through get(). */
  const capabilities = (entries: Record<string, unknown>) => ({ get: (key: string) => entries[key] });

  it('Chrome over CDP: full page, with the browser and chromedriver from getCapabilities()', async () => {
    const { driver } = makeDriver({
      sendAndGetDevToolsCommand: jest.fn().mockResolvedValue({ data: ONE_PX_PNG_B64 }),
      getCapabilities: jest.fn().mockResolvedValue(
        capabilities({ browserName: 'chrome', browserVersion: '141.0.7390.37', chrome: { chromedriverVersion: '141.0.7390.37 (abc)' } }),
      ),
    });
    await witness(driver, 'home');
    expect(metadata('home').environment).toMatchObject({
      os: { platform: process.platform },
      browser: { name: 'chromium', version: '141.0.7390.37', channel: 'chrome' },
      framework: { name: 'selenium-webdriver' },
      adapter: { name: '@testivai/witness-selenium', captureMethod: 'full-page:cdp' },
      driver: { name: 'chromedriver', version: '141.0.7390.37' },
      render: { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'de-DE', timezone: 'Europe/Berlin' },
    });
  });

  it('without CDP the capture is the viewport, and without capabilities the browser comes from the user agent', async () => {
    const { driver } = makeDriver();
    await witness(driver, 'home');
    const { environment } = metadata('home');
    expect(environment.adapter.captureMethod).toBe('viewport:webdriver');
    expect(environment.browser).toEqual({ name: 'firefox', version: '143.0' });
  });

  it('a CDP failure falls back to the viewport, and the method says so', async () => {
    const { driver } = makeDriver({ sendAndGetDevToolsCommand: jest.fn().mockRejectedValue(new Error('no CDP')) });
    await witness(driver, 'home');
    expect(metadata('home').environment.adapter.captureMethod).toBe('viewport:webdriver');
  });

  it('environmentPolicy "separate" keys the snapshot <name>__<browser>__<platform>', async () => {
    fs.mkdirSync(path.join(projectRoot, '.testivai'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.testivai', 'config.json'), JSON.stringify({ environmentPolicy: 'separate' }));
    const { driver } = makeDriver();
    await witness(driver, 'home');
    expect(fs.existsSync(path.join(projectRoot, '.testivai', 'temp', `home__firefox__${process.platform}`, 'screenshot.png'))).toBe(true);
  });
});
