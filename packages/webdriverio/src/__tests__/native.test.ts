/**
 * Native mode: witness() in an Appium session driving a native app.
 *
 * A native screen has no page: Appium rejects every page script there
 * (UiAutomator2 answers 405 NotImplementedError), and WebdriverIO resends a
 * failed command three times, so on a real Android 14 emulator each rejected
 * script cost ~1.5 s and one capture ~8 s (e2e/src/android-native.ts, Level 0).
 * Native mode is detected from the capabilities and the current context, and
 * then: no page scripts, the status bar masked, an environment block from the
 * capabilities, and the snapshot keyed by device
 * (`<name>__<platform>-<device>-<osMajor>`).
 *
 * The status bar's height: on Android, the window manager's frame of the bar
 * at capture time (`mobile: getSystemBars`). UiAutomator2's own figure
 * (`mobile: viewportRect`, `statBarHeight`) is read once, when the session
 * starts, from a resource of its server app; on the Android 14 emulator it
 * came back 63 px for a 136 px bar in 1 of the first 5 CI runs, and it does
 * not follow a rotation. It stays the fallback, and iOS's source.
 *
 * The fake drivers answer as Appium does: page scripts rejected, `mobile:`
 * commands answered, the context from getContext().
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import { compareAll } from '@testivai/witness';

import { witness } from '../witness';
import type { WitnessBrowser } from '../types';

// ── a tiny PNG encoder (RGBA, no filter), so the compare can read real images ──

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** A width × height PNG, white, with `dark` rows [from, to) painted black. */
function png(width: number, height: number, dark?: { from: number; to: number }): string {
  const raw = Buffer.alloc((width * 4 + 1) * height, 0xff);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    if (dark && y >= dark.from && y < dark.to) {
      for (let x = 0; x < width; x++) {
        const i = y * (width * 4 + 1) + 1 + x * 4;
        raw[i] = raw[i + 1] = raw[i + 2] = 0;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

// ── fake Appium sessions ──

/** What Appium 3.9 + UiAutomator2 8.7 returned for Settings on an Android 14 emulator. */
const ANDROID_CAPS = {
  platformName: 'Android',
  automationName: 'UiAutomator2',
  appPackage: 'com.android.settings',
  appActivity: '.Settings',
  desired: { platformName: 'Android', automationName: 'UiAutomator2', appPackage: 'com.android.settings', appActivity: '.Settings' },
  deviceName: 'emulator-5554',
  pixelRatio: '2.625',
  statBarHeight: 136,
  viewportRect: { left: 0, top: 136, width: 1080, height: 2264 },
  platformVersion: '14',
  deviceModel: 'sdk_gphone64_x86_64',
  deviceScreenSize: '1080x2400',
  deviceScreenDensity: 420,
};

const IOS_CAPS = {
  platformName: 'iOS',
  'appium:automationName': 'XCUITest',
  'appium:deviceName': 'iPhone 15',
  'appium:platformVersion': '17.5',
  'appium:bundleId': 'com.example.app',
};

const PAGE_DOM = '<html><body><h1>Hi</h1></body></html>';

/** A `mobile: getSystemBars` answer in the Android driver's shape, with a status bar `height` px tall. */
function systemBars(height: number, width = 1080): Record<string, unknown> {
  return {
    statusBar: { visible: true, x: 0, y: 0, width, height },
    navigationBar: { visible: true, x: 0, y: 2337, width: 1080, height: 63 },
  };
}

interface FakeSession {
  browser: WitnessBrowser;
  /** Every script passed to execute(), in order. */
  scripts: string[];
  getContext: jest.Mock;
}

/**
 * An Appium session. In NATIVE_APP every page script is rejected, as Appium
 * does; `mobile: viewportRect` answers `viewportRect` and
 * `mobile: getSystemBars` answers `systemBars` (each rejects when it is an
 * Error). In a web view or a browser (WEBVIEW_…, CHROMIUM) page scripts run.
 */
function appiumSession(opts: {
  capabilities: Record<string, unknown>;
  context?: string | Error | 'absent';
  viewportRect?: Record<string, number> | Error;
  systemBars?: Record<string, unknown> | Error;
  screenshot?: string;
}): FakeSession {
  const scripts: string[] = [];
  const context = opts.context ?? 'NATIVE_APP';
  const getContext = jest.fn(async () => {
    if (context instanceof Error) throw context;
    return context;
  });
  const browser: WitnessBrowser = {
    capabilities: opts.capabilities,
    takeScreenshot: jest.fn().mockResolvedValue(opts.screenshot ?? png(4, 8)),
    execute: jest.fn(async (script: unknown) => {
      const s = String(script);
      scripts.push(s);
      if (s === 'mobile: viewportRect') {
        if (opts.viewportRect instanceof Error) throw opts.viewportRect;
        return opts.viewportRect ?? { left: 0, top: 136, width: 1080, height: 2264 };
      }
      if (s === 'mobile: getSystemBars') {
        if (opts.systemBars instanceof Error) throw opts.systemBars;
        return opts.systemBars ?? systemBars(136);
      }
      if (typeof context === 'string' && /^(WEBVIEW|CHROMIUM)/.test(context)) return PAGE_DOM;
      throw new Error('Method is not implemented');
    }) as WitnessBrowser['execute'],
    ...(context === 'absent' ? {} : { getContext }),
  };
  return { browser, scripts, getContext };
}

const pageScripts = (scripts: string[]) => scripts.filter((s) => !s.startsWith('mobile:'));

describe('witness() native mode', () => {
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-wdio-native-'));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const tempDir = (name: string) => path.join(projectRoot, '.testivai', 'temp', name);
  const metadata = (name: string) => JSON.parse(fs.readFileSync(path.join(tempDir(name), 'metadata.json'), 'utf-8'));
  const ANDROID_NAME = 'settings__android-sdk_gphone64_x86_64-14';

  describe('an Android app in the native context', () => {
    it('writes the screenshot and metadata only, runs no page script, and keys the snapshot by device', async () => {
      const s = appiumSession({ capabilities: ANDROID_CAPS });
      await witness(s.browser, 'settings');

      expect(fs.readdirSync(tempDir(ANDROID_NAME)).sort()).toEqual(['metadata.json', 'screenshot.png']);
      expect(pageScripts(s.scripts)).toEqual([]);
      expect(s.scripts).toEqual(['mobile: getSystemBars']);
      expect(s.getContext).toHaveBeenCalledTimes(1);
      expect(s.browser.takeScreenshot).toHaveBeenCalledTimes(1);
    });

    it('records the environment from the capabilities and masks the status bar', async () => {
      await witness(appiumSession({ capabilities: ANDROID_CAPS }).browser, 'settings');
      const meta = metadata(ANDROID_NAME);

      expect(meta.name).toBe(ANDROID_NAME);
      expect(meta.masks).toEqual([{ top: 136 }]);
      expect(meta.environment.browser).toEqual({ name: 'native-app', version: null });
      expect(meta.environment.adapter).toMatchObject({ name: '@testivai/witness-webdriverio', captureMethod: 'screen:appium' });
      expect(meta.environment.device).toEqual({
        platform: 'android',
        osVersion: '14',
        model: 'sdk_gphone64_x86_64',
        automation: 'UiAutomator2',
        screen: '1080x2400',
        density: 420,
      });
      expect(meta.environment.render).toEqual({ deviceScaleFactor: 2.625 });
      expect(meta.environment.os.platform).toBe(process.platform);
    });

    it("masks the window manager's status bar, not UiAutomator2's short reading from the session start", async () => {
      // The CI run on 744d8bd: UiAutomator2 said 63 px all session, the bar was 136 px tall.
      const shortReading = { ...ANDROID_CAPS, statBarHeight: 63, viewportRect: { left: 0, top: 63, width: 1080, height: 2337 } };
      const s = appiumSession({ capabilities: shortReading, viewportRect: shortReading.viewportRect, systemBars: systemBars(136) });
      await witness(s.browser, 'settings');
      expect(metadata(ANDROID_NAME).masks).toEqual([{ top: 136 }]);
      expect(s.scripts).toEqual(['mobile: getSystemBars']);
    });

    it('follows a rotation: the landscape bar, not the portrait height the session started with', async () => {
      const s = appiumSession({ capabilities: ANDROID_CAPS, systemBars: systemBars(63, 2400) });
      await witness(s.browser, 'settings');
      expect(metadata(ANDROID_NAME).masks).toEqual([{ top: 63 }]);
    });

    it('falls back to mobile: viewportRect when getSystemBars fails, and asks for it once per session', async () => {
      const s = appiumSession({
        capabilities: ANDROID_CAPS,
        viewportRect: { left: 0, top: 136, width: 1080, height: 2264 },
        systemBars: new Error('Cannot parse any window information from the dumpsys output'),
      });
      await witness(s.browser, 'settings');
      expect(metadata(ANDROID_NAME).masks).toEqual([{ top: 136 }]);
      await witness(s.browser, 'settings');
      expect(s.scripts).toEqual(['mobile: getSystemBars', 'mobile: viewportRect', 'mobile: viewportRect']);
    });

    it('falls back to mobile: viewportRect when the window manager shows no status bar, and asks again next time', async () => {
      const s = appiumSession({ capabilities: ANDROID_CAPS, systemBars: { statusBar: { visible: false, x: 0, y: 0, width: 0, height: 0 } } });
      await witness(s.browser, 'settings');
      await witness(s.browser, 'settings');
      expect(metadata(ANDROID_NAME).masks).toEqual([{ top: 136 }]);
      expect(s.scripts).toEqual(['mobile: getSystemBars', 'mobile: viewportRect', 'mobile: getSystemBars', 'mobile: viewportRect']);
    });

    it('falls back to the capabilities when getSystemBars and mobile: viewportRect both fail', async () => {
      const s = appiumSession({ capabilities: ANDROID_CAPS, viewportRect: new Error('unknown method'), systemBars: new Error('unknown method') });
      await witness(s.browser, 'settings');
      expect(metadata(ANDROID_NAME).masks).toEqual([{ top: 136 }]);
    });

    it('writes no mask when nothing says where the status bar is', async () => {
      const caps = { ...ANDROID_CAPS, viewportRect: undefined, statBarHeight: undefined };
      await witness(
        appiumSession({ capabilities: caps, viewportRect: new Error('unknown method'), systemBars: new Error('unknown method') }).browser,
        'settings',
      );
      expect(metadata(ANDROID_NAME).masks).toBeUndefined();
      expect(fs.existsSync(path.join(tempDir(ANDROID_NAME), 'screenshot.png'))).toBe(true);
    });

    it('maskStatusBar: false leaves the status bar in, and does not ask for it', async () => {
      const s = appiumSession({ capabilities: ANDROID_CAPS });
      await witness(s.browser, 'settings', { maskStatusBar: false });
      expect(metadata(ANDROID_NAME).masks).toBeUndefined();
      expect(s.scripts).toEqual([]);
    });

    it('a re-capture under the same name leaves nothing from the one before (no DOM, no stale mask)', async () => {
      fs.mkdirSync(tempDir(ANDROID_NAME), { recursive: true });
      fs.writeFileSync(path.join(tempDir(ANDROID_NAME), 'dom.html'), PAGE_DOM);
      fs.writeFileSync(path.join(tempDir(ANDROID_NAME), 'elements.json'), '[]');
      fs.writeFileSync(path.join(tempDir(ANDROID_NAME), 'metadata.json'), JSON.stringify({ masks: [{ top: 99 }], health: {} }));
      await witness(appiumSession({ capabilities: ANDROID_CAPS }).browser, 'settings', { maskStatusBar: false });
      expect(fs.readdirSync(tempDir(ANDROID_NAME)).sort()).toEqual(['metadata.json', 'screenshot.png']);
      expect(metadata(ANDROID_NAME).masks).toBeUndefined();
      expect(metadata(ANDROID_NAME).health).toBeUndefined();
    });

    it('an explicit variant replaces the device key', async () => {
      await witness(appiumSession({ capabilities: ANDROID_CAPS }).browser, 'settings', { variant: 'Pixel 7' });
      expect(fs.existsSync(path.join(tempDir('settings__pixel_7'), 'screenshot.png'))).toBe(true);
      expect(fs.existsSync(tempDir(ANDROID_NAME))).toBe(false);
    });

    it('decides from the capabilities when the session cannot report its context', async () => {
      const absent = appiumSession({ capabilities: ANDROID_CAPS, context: 'absent' });
      await witness(absent.browser, 'settings');
      expect(pageScripts(absent.scripts)).toEqual([]);

      const failing = appiumSession({ capabilities: ANDROID_CAPS, context: new Error('getContext failed') });
      await witness(failing.browser, 'settings-2');
      expect(pageScripts(failing.scripts)).toEqual([]);
      expect(fs.existsSync(path.join(tempDir('settings-2__android-sdk_gphone64_x86_64-14'), 'screenshot.png'))).toBe(true);
    });

    it('the status-bar mask makes a clock change pass, and a change below it still counts', async () => {
      const W = 20;
      const H = 40;
      const caps = { ...ANDROID_CAPS, viewportRect: { left: 0, top: 6, width: W, height: H - 6 } };
      const capture = (dark?: { from: number; to: number }) =>
        witness(
          appiumSession({ capabilities: caps, viewportRect: caps.viewportRect, systemBars: systemBars(6, W), screenshot: png(W, H, dark) })
            .browser,
          'settings',
        );
      const store = path.join(projectRoot, '.testivai');
      const approve = () => {
        fs.cpSync(tempDir(ANDROID_NAME), path.join(store, 'baselines', ANDROID_NAME), { recursive: true });
        fs.rmSync(path.join(store, 'temp'), { recursive: true, force: true });
      };

      await capture({ from: 1, to: 3 }); // the clock at 12:00
      approve();
      await capture({ from: 2, to: 5 }); // 12:01: rows 1–4, inside the 6 px status bar
      expect(compareAll({ projectRoot, reportDir: 'visual-report' }).find((r) => r.name === ANDROID_NAME)?.status).toBe('passed');

      await capture({ from: 10, to: 14 }); // a change below the status bar
      expect(compareAll({ projectRoot, reportDir: 'visual-report' }).find((r) => r.name === ANDROID_NAME)?.status).toBe('changed');
    });

    it("a clock change passes when UiAutomator2's reading is short, as in the failed CI run", async () => {
      const W = 20;
      const H = 40;
      // UiAutomator2 read 3 px for a bar that draws 6 px: the clock reaches rows 3–4.
      const caps = { ...ANDROID_CAPS, statBarHeight: 3, viewportRect: { left: 0, top: 3, width: W, height: H - 3 } };
      const capture = (dark: { from: number; to: number }) =>
        witness(
          appiumSession({ capabilities: caps, viewportRect: caps.viewportRect, systemBars: systemBars(6, W), screenshot: png(W, H, dark) })
            .browser,
          'settings',
        );
      await capture({ from: 1, to: 3 });
      fs.cpSync(tempDir(ANDROID_NAME), path.join(projectRoot, '.testivai', 'baselines', ANDROID_NAME), { recursive: true });
      fs.rmSync(path.join(projectRoot, '.testivai', 'temp'), { recursive: true, force: true });
      await capture({ from: 2, to: 5 });
      expect(metadata(ANDROID_NAME).masks).toEqual([{ top: 6 }]);
      expect(compareAll({ projectRoot, reportDir: 'visual-report' }).find((r) => r.name === ANDROID_NAME)?.status).toBe('passed');
    });
  });

  describe('an iOS app in the native context', () => {
    it('is keyed ios-<device>-<osMajor> and masked from mobile: viewportRect', async () => {
      const s = appiumSession({ capabilities: IOS_CAPS, viewportRect: { left: 0, top: 162, width: 1179, height: 2394 } });
      await witness(s.browser, 'login');
      const meta = metadata('login__ios-iphone_15-17');
      expect(meta.masks).toEqual([{ top: 162 }]);
      expect(meta.environment.device).toEqual({ platform: 'ios', osVersion: '17.5', name: 'iPhone 15', automation: 'XCUITest' });
      expect(pageScripts(s.scripts)).toEqual([]);
      // getSystemBars is the Android driver's: XCUITest would reject it, and WebdriverIO would resend it.
      expect(s.scripts).toEqual(['mobile: viewportRect']);
    });
  });

  describe('sessions that stay on the web path', () => {
    it('a hybrid app switched to a webview runs the page scripts, unkeyed', async () => {
      const s = appiumSession({ capabilities: ANDROID_CAPS, context: 'WEBVIEW_com.example.app' });
      await witness(s.browser, 'checkout');
      expect(fs.existsSync(path.join(tempDir('checkout'), 'dom.html'))).toBe(true);
      expect(pageScripts(s.scripts).length).toBeGreaterThan(0);
      expect(s.scripts).not.toContain('mobile: viewportRect');
      expect(s.scripts).not.toContain('mobile: getSystemBars');
    });

    it('a mobile browser session never asks for the context', async () => {
      const s = appiumSession({ capabilities: { platformName: 'Android', browserName: 'chrome', 'appium:automationName': 'UiAutomator2' }, context: 'CHROMIUM' });
      await witness(s.browser, 'home');
      expect(s.getContext).not.toHaveBeenCalled();
      expect(s.scripts).not.toContain('mobile: viewportRect');
      expect(s.scripts).not.toContain('mobile: getSystemBars');
      expect(fs.existsSync(path.join(tempDir('home'), 'dom.html'))).toBe(true);
    });

    it('a desktop browser session never asks for the context', async () => {
      const s = appiumSession({ capabilities: { browserName: 'chrome', platformName: 'linux' }, context: 'NATIVE_APP' });
      await witness(s.browser, 'home');
      expect(s.getContext).not.toHaveBeenCalled();
    });
  });

  describe('the native option', () => {
    it('native: false keeps an app session on the web path', async () => {
      const s = appiumSession({ capabilities: ANDROID_CAPS });
      await witness(s.browser, 'settings', { native: false });
      expect(pageScripts(s.scripts).length).toBeGreaterThan(0);
      expect(s.getContext).not.toHaveBeenCalled();
      expect(fs.existsSync(tempDir('settings'))).toBe(true);
    });

    it('a mobile session that names no app is native when its context is NATIVE_APP', async () => {
      const caps = { platformName: 'Android', 'appium:automationName': 'UiAutomator2', platformVersion: '14', deviceModel: 'Pixel 7' };
      const s = appiumSession({ capabilities: caps });
      await witness(s.browser, 'launcher');
      expect(pageScripts(s.scripts)).toEqual([]);
      expect(fs.existsSync(path.join(tempDir('launcher__android-pixel_7-14'), 'screenshot.png'))).toBe(true);
    });

    it('native: true needs no context answer', async () => {
      const caps = { platformName: 'Android', platformVersion: '14', deviceModel: 'Pixel 7' };
      const s = appiumSession({ capabilities: caps, context: 'absent' });
      await witness(s.browser, 'launcher', { native: true });
      expect(pageScripts(s.scripts)).toEqual([]);
      expect(fs.existsSync(path.join(tempDir('launcher__android-pixel_7-14'), 'screenshot.png'))).toBe(true);
    });
  });
});
