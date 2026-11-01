/**
 * The `context` option: capture in another Appium context for one call.
 *
 * A hybrid app's tests usually drive the app in the NATIVE_APP context, where
 * witness() takes a native capture (pixel-only). `context: 'webview'` captures
 * the app's web view as a page instead, with every layer, and switches back
 * afterwards, also when the capture fails. An exact context name works too.
 *
 * The fake session behaves as Appium does: page scripts run only in a web
 * view, `mobile:` commands only in NATIVE_APP, and the context is whatever
 * switchContext() last set.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { witness } from '../witness';
import type { WitnessBrowser } from '../types';

const ONE_PX_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
const PAGE_DOM = '<html><body><h1>Checkout</h1></body></html>';

const HYBRID_CAPS = {
  platformName: 'Android',
  automationName: 'UiAutomator2',
  appPackage: 'com.example.app',
  appActivity: '.MainActivity',
  platformVersion: '14',
  deviceModel: 'Pixel 7',
  viewportRect: { left: 0, top: 136, width: 1080, height: 2264 },
};

interface HybridSession {
  browser: WitnessBrowser;
  /** Every switchContext() argument, in order. */
  switches: string[];
  /** The context each screenshot was taken in. */
  shotsIn: string[];
  /** The context now. */
  current(): string;
}

function hybridSession(opts: { contexts?: string[]; start?: string; failScreenshotIn?: string } = {}): HybridSession {
  const contexts = opts.contexts ?? ['NATIVE_APP', 'WEBVIEW_com.example.app'];
  let current = opts.start ?? 'NATIVE_APP';
  const switches: string[] = [];
  const shotsIn: string[] = [];
  const browser: WitnessBrowser = {
    capabilities: HYBRID_CAPS,
    getContext: jest.fn(async () => current),
    getContexts: jest.fn(async () => [...contexts]),
    switchContext: jest.fn(async (name: string) => {
      if (!contexts.includes(name)) throw new Error(`No such context found: ${name}`);
      switches.push(name);
      current = name;
    }),
    takeScreenshot: jest.fn(async () => {
      shotsIn.push(current);
      if (opts.failScreenshotIn === current) throw new Error('screenshot failed');
      return ONE_PX_PNG_B64;
    }),
    execute: jest.fn(async (script: unknown) => {
      const s = String(script);
      if (s.startsWith('mobile:')) {
        if (current !== 'NATIVE_APP') throw new Error('mobile: commands need NATIVE_APP');
        return { left: 0, top: 136, width: 1080, height: 2264 };
      }
      if (current === 'NATIVE_APP') throw new Error('Method is not implemented');
      return PAGE_DOM;
    }) as WitnessBrowser['execute'],
  };
  return { browser, switches, shotsIn, current: () => current };
}

describe('witness() context option', () => {
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-wdio-context-'));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const tempDir = (name: string) => path.join(projectRoot, '.testivai', 'temp', name);

  it("context: 'webview' from NATIVE_APP captures the web view as a page and switches back", async () => {
    const s = hybridSession();
    await witness(s.browser, 'checkout', { context: 'webview' });

    expect(fs.existsSync(path.join(tempDir('checkout'), 'dom.html'))).toBe(true);
    expect(fs.readdirSync(path.join(projectRoot, '.testivai', 'temp'))).toEqual(['checkout']);
    expect(s.shotsIn).toEqual(['WEBVIEW_com.example.app']);
    expect(s.switches).toEqual(['WEBVIEW_com.example.app', 'NATIVE_APP']);
    expect(s.current()).toBe('NATIVE_APP');
  });

  it("prefers the app's own web view over another one", async () => {
    const s = hybridSession({ contexts: ['NATIVE_APP', 'WEBVIEW_chrome', 'WEBVIEW_com.example.app'] });
    await witness(s.browser, 'checkout', { context: 'webview' });
    expect(s.shotsIn).toEqual(['WEBVIEW_com.example.app']);
  });

  it('takes the first web view when none is named after the app (iOS names them by number)', async () => {
    const s = hybridSession({ contexts: ['NATIVE_APP', 'WEBVIEW_8410.1', 'WEBVIEW_8410.2'] });
    await witness(s.browser, 'checkout', { context: 'webview' });
    expect(s.shotsIn).toEqual(['WEBVIEW_8410.1']);
  });

  it('takes an exact context name', async () => {
    const s = hybridSession({ contexts: ['NATIVE_APP', 'WEBVIEW_chrome', 'WEBVIEW_com.example.app'] });
    await witness(s.browser, 'checkout', { context: 'WEBVIEW_chrome' });
    expect(s.shotsIn).toEqual(['WEBVIEW_chrome']);
    expect(s.current()).toBe('NATIVE_APP');
  });

  it('does not switch when the session is already in that context', async () => {
    const s = hybridSession({ start: 'WEBVIEW_com.example.app' });
    await witness(s.browser, 'checkout', { context: 'webview' });
    expect(s.switches).toEqual([]);
    expect(fs.existsSync(path.join(tempDir('checkout'), 'dom.html'))).toBe(true);
  });

  it('switches back when the capture fails, and the failure still surfaces', async () => {
    const s = hybridSession({ failScreenshotIn: 'WEBVIEW_com.example.app' });
    await expect(witness(s.browser, 'checkout', { context: 'webview' })).rejects.toThrow('screenshot failed');
    expect(s.current()).toBe('NATIVE_APP');
  });

  it('fails clearly when the app has no web view, and writes nothing', async () => {
    const s = hybridSession({ contexts: ['NATIVE_APP'] });
    await expect(witness(s.browser, 'checkout', { context: 'webview' })).rejects.toThrow(
      /no web view context .*NATIVE_APP.*WebView debugging/s,
    );
    expect(s.switches).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, '.testivai', 'temp'))).toBe(false);
  });

  it('fails clearly for a context name the session does not have', async () => {
    const s = hybridSession();
    await expect(witness(s.browser, 'checkout', { context: 'WEBVIEW_other' })).rejects.toThrow(
      /context "WEBVIEW_other" .*NATIVE_APP, WEBVIEW_com\.example\.app/s,
    );
  });

  it("context: 'NATIVE_APP' from the web view is a native capture, and switches back", async () => {
    const s = hybridSession({ start: 'WEBVIEW_com.example.app' });
    await witness(s.browser, 'checkout', { context: 'NATIVE_APP' });
    expect(fs.readdirSync(tempDir('checkout__android-pixel_7-14')).sort()).toEqual(['metadata.json', 'screenshot.png']);
    expect(s.shotsIn).toEqual(['NATIVE_APP']);
    expect(s.current()).toBe('WEBVIEW_com.example.app');
  });

  it('fails clearly when the session has no context commands (not Appium)', async () => {
    const browser: WitnessBrowser = {
      takeScreenshot: jest.fn().mockResolvedValue(ONE_PX_PNG_B64),
      execute: jest.fn().mockResolvedValue(PAGE_DOM) as WitnessBrowser['execute'],
    };
    await expect(witness(browser, 'checkout', { context: 'webview' })).rejects.toThrow(/getContexts.*switchContext/);
    expect(browser.takeScreenshot).not.toHaveBeenCalled();
  });
});
