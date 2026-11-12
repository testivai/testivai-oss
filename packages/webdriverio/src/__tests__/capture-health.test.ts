/**
 * Capture health for the WebdriverIO adapter: what failed to load (web fonts,
 * stylesheets, images, requests that answered 400 or more), read by the shared
 * probe (HEALTH_PROBE_EXPRESSION, as WebDriver runs it: `return <expression>`)
 * right after the screenshot, before the capture style comes off, and
 * recorded as `health` in the capture's metadata.json, as the Playwright
 * adapter records it. A probe that fails or answers something malformed
 * records nothing: not checked, never healthy. A native app screen has no
 * page, so it is never probed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HEALTH_PROBE_EXPRESSION } from '@testivai/witness';

import { witness } from '../witness';
import type { WitnessBrowser } from '../types';

const ONE_PX_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.37 Safari/537.36';
const HEALTH_SCRIPT = `return ${HEALTH_PROBE_EXPRESSION}`;

const HEALTHY = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};
const BROKEN_STYLESHEET = {
  ...HEALTHY,
  stylesheets: { failed: 1, urls: ['localhost:3000/missing.css'] },
  resources: { status: 'checked', failed: { css: { count: 1, entries: [{ url: 'localhost:3000/missing.css', status: 404 }] } } },
};

interface Options {
  /** What the health probe answers; an Error is thrown. */
  health?: unknown;
  /** The render probe's user agent; null answers none. */
  userAgent?: string | null;
  failScreenshot?: boolean;
}

function healthBrowser({ health = HEALTHY, userAgent = CHROME_UA, failScreenshot = false }: Options = {}) {
  const log: string[] = [];
  const scripts: string[] = [];
  const execute = jest.fn(async (script: unknown) => {
    const s = String(script);
    scripts.push(s);
    if (s === HEALTH_SCRIPT) {
      log.push('health');
      if (health instanceof Error) throw health;
      return health;
    }
    if (s.includes('prefers-color-scheme')) return userAgent === null ? {} : { userAgent };
    if (s.includes("createElement('style')")) return void log.push('add_style');
    if (s.includes('getElementById') && s.includes('remove')) return void log.push('remove_style');
    if (s.includes("document.fonts.status : 'loaded'")) return 'loaded';
    if (s.includes('cloneNode')) return void log.push('dom');
    return undefined;
  });
  const browser: WitnessBrowser = {
    takeScreenshot: jest.fn(async () => {
      log.push('screenshot');
      if (failScreenshot) throw new Error('no screenshot');
      return ONE_PX_PNG_B64;
    }),
    execute: execute as unknown as WitnessBrowser['execute'],
  };
  return { browser, log, scripts };
}

describe('witness(): capture health', () => {
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-wdio-health-'));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const metaPath = (name: string) => path.join(projectRoot, '.testivai', 'temp', name, 'metadata.json');
  const metadata = (name: string) => JSON.parse(fs.readFileSync(metaPath(name), 'utf8'));

  it('records the probe\'s result as health in metadata.json, beside the environment', async () => {
    await witness(healthBrowser().browser, 'home');
    const meta = metadata('home');
    expect(meta.health).toEqual(HEALTHY);
    expect(meta.environment.browser.name).toBe('chromium');
    expect(meta.name).toBe('home');
  });

  it('records a stylesheet that failed', async () => {
    await witness(healthBrowser({ health: BROKEN_STYLESHEET }).browser, 'broken');
    expect(metadata('broken').health).toEqual(BROKEN_STYLESHEET);
  });

  it('sends the shared probe as WebDriver runs it: return <HEALTH_PROBE_EXPRESSION>', async () => {
    const { browser, scripts } = healthBrowser();
    await witness(browser, 'home');
    expect(scripts.filter((s) => s === HEALTH_SCRIPT)).toHaveLength(1);
  });

  it('reads it right after the screenshot, before the style comes off', async () => {
    const { browser, log } = healthBrowser();
    await witness(browser, 'order');
    expect(log).toEqual(['add_style', 'screenshot', 'health', 'remove_style', 'dom']);
  });

  it.each([
    ['a probe that throws', new Error('stale element')],
    ['no answer', null],
    ['a malformed answer', { fonts: 'loaded' }],
    ['text', 'healthy'],
  ])('%s records no health (not checked, never healthy)', async (_label, answer) => {
    await witness(healthBrowser({ health: answer }).browser, 'unchecked');
    expect(fs.existsSync(path.join(projectRoot, '.testivai', 'temp', 'unchecked', 'screenshot.png'))).toBe(true);
    expect('health' in metadata('unchecked')).toBe(false);
  });

  it('records health even when nothing names the browser', async () => {
    await witness(healthBrowser({ userAgent: null }).browser, 'anon');
    expect(metadata('anon')).toEqual({ name: 'anon', health: HEALTHY });
  });

  it("drops an earlier capture's health when this one could not check", async () => {
    await witness(healthBrowser({ health: BROKEN_STYLESHEET }).browser, 'again');
    await witness(healthBrowser({ health: new Error('gone') }).browser, 'again');
    const meta = metadata('again');
    expect('health' in meta).toBe(false);
    expect(meta.environment.browser.name).toBe('chromium');
  });

  it('a failed screenshot runs no probe, and the style still comes off', async () => {
    const { browser, log } = healthBrowser({ failScreenshot: true });
    await expect(witness(browser, 'boom')).rejects.toThrow('no screenshot');
    expect(log).not.toContain('health');
    expect(log).toContain('remove_style');
  });

  it('a browser without execute records no health', async () => {
    const browser = { takeScreenshot: jest.fn().mockResolvedValue(ONE_PX_PNG_B64) } as unknown as WitnessBrowser;
    await witness(browser, 'bare');
    expect(fs.existsSync(metaPath('bare'))).toBe(false);
  });

  it('a native app screen is never probed: it has no page', async () => {
    const { browser, scripts } = healthBrowser();
    browser.capabilities = { platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:deviceName': 'Pixel 7', 'appium:appPackage': 'com.example' };
    await witness(browser, 'screen', { native: true });
    expect(scripts).not.toContain(HEALTH_SCRIPT);
    const native = fs.readdirSync(path.join(projectRoot, '.testivai', 'temp')).find((d) => d.startsWith('screen'));
    expect(native).toBeDefined();
    expect('health' in JSON.parse(fs.readFileSync(path.join(projectRoot, '.testivai', 'temp', native as string, 'metadata.json'), 'utf8'))).toBe(false);
  });
});
