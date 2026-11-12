/**
 * Capture health for the Selenium adapter: what failed to load (web fonts,
 * stylesheets, images, requests that answered 400 or more), read by the shared
 * probe (HEALTH_PROBE_EXPRESSION, as WebDriver runs it: `return <expression>`)
 * right after the screenshot, before the capture style comes off and the settle
 * observer stops, and recorded as `health` in the capture's metadata.json, as
 * the Playwright adapter records it. A probe that fails or answers something
 * malformed records nothing: not checked, never healthy.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HEALTH_PROBE_EXPRESSION } from '@testivai/witness';

import { witness } from '../witness';
import type { WitnessDriver } from '../types';

const ONE_PX_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0';
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

function healthDriver({ health = HEALTHY, userAgent = FIREFOX_UA, failScreenshot = false }: Options = {}) {
  const log: string[] = [];
  const scripts: string[] = [];
  const executeScript = jest.fn(async (script: string) => {
    scripts.push(script);
    if (script === HEALTH_SCRIPT) {
      log.push('health');
      if (health instanceof Error) throw health;
      return health;
    }
    if (script.includes('prefers-color-scheme')) return userAgent === null ? {} : { userAgent };
    if (script.includes("createElement('style')")) return void log.push('add_style');
    if (script.includes('getElementById') && script.includes('remove')) return void log.push('remove_style');
    if (script.includes("document.fonts.status !== 'loading'")) return true;
    if (script.includes('settleProbe')) return { settled: true };
    if (script.includes('observer.disconnect')) return void log.push('stop_settle');
    if (script.includes('cloneNode')) return void log.push('dom');
    return undefined;
  });
  const driver: WitnessDriver = {
    takeScreenshot: jest.fn(async () => {
      log.push('screenshot');
      if (failScreenshot) throw new Error('no screenshot');
      return ONE_PX_PNG_B64;
    }),
    executeScript: executeScript as WitnessDriver['executeScript'],
  };
  return { driver, log, scripts };
}

describe('witness(): capture health', () => {
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-selenium-health-'));
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
    await witness(healthDriver().driver, 'home');
    const meta = metadata('home');
    expect(meta.health).toEqual(HEALTHY);
    expect(meta.environment.browser.name).toBe('firefox');
    expect(meta.name).toBe('home');
  });

  it('records a stylesheet that failed', async () => {
    await witness(healthDriver({ health: BROKEN_STYLESHEET }).driver, 'broken');
    expect(metadata('broken').health).toEqual(BROKEN_STYLESHEET);
  });

  it('sends the shared probe as WebDriver runs it: return <HEALTH_PROBE_EXPRESSION>', async () => {
    const { driver, scripts } = healthDriver();
    await witness(driver, 'home');
    expect(scripts.filter((s) => s === HEALTH_SCRIPT)).toHaveLength(1);
  });

  it('reads it right after the screenshot, before the style comes off and the settle observer stops', async () => {
    const { driver, log } = healthDriver();
    await witness(driver, 'order');
    expect(log).toEqual(['add_style', 'screenshot', 'health', 'remove_style', 'stop_settle', 'dom']);
  });

  it('reads it after a full-page CDP capture too', async () => {
    const { driver, log } = healthDriver();
    driver.sendAndGetDevToolsCommand = jest.fn(async (cmd: string, params?: Record<string, unknown>): Promise<any> => {
      if (cmd === 'Runtime.evaluate') return { result: { type: 'boolean', value: params?.awaitPromise === true } };
      if (cmd === 'Page.getLayoutMetrics') return { cssContentSize: { x: 0, y: 0, width: 800, height: 900 } };
      log.push('cdp_capture');
      return { data: ONE_PX_PNG_B64 };
    });
    await witness(driver, 'cdp');
    expect(log.indexOf('health')).toBeGreaterThan(log.lastIndexOf('cdp_capture'));
    expect(log.indexOf('health')).toBeLessThan(log.indexOf('remove_style'));
    expect(metadata('cdp').health).toEqual(HEALTHY);
  });

  it.each([
    ['a probe that throws', new Error('stale element')],
    ['no answer', null],
    ['a malformed answer', { fonts: 'loaded' }],
    ['text', 'healthy'],
  ])('%s records no health (not checked, never healthy)', async (_label, answer) => {
    await witness(healthDriver({ health: answer }).driver, 'unchecked');
    expect(fs.existsSync(path.join(projectRoot, '.testivai', 'temp', 'unchecked', 'screenshot.png'))).toBe(true);
    expect('health' in metadata('unchecked')).toBe(false);
  });

  it('records health even when nothing names the browser', async () => {
    await witness(healthDriver({ userAgent: null }).driver, 'anon');
    expect(metadata('anon')).toEqual({ name: 'anon', health: HEALTHY });
  });

  it("drops an earlier capture's health when this one could not check", async () => {
    await witness(healthDriver({ health: BROKEN_STYLESHEET }).driver, 'again');
    await witness(healthDriver({ health: new Error('gone') }).driver, 'again');
    const meta = metadata('again');
    expect('health' in meta).toBe(false);
    expect(meta.environment.browser.name).toBe('firefox');
  });

  it('a failed screenshot runs no probe, and the style still comes off', async () => {
    const { driver, log } = healthDriver({ failScreenshot: true });
    await expect(witness(driver, 'boom')).rejects.toThrow('no screenshot');
    expect(log).not.toContain('health');
    expect(log).toContain('remove_style');
  });

  it('a driver without executeScript records no health', async () => {
    const driver = { takeScreenshot: jest.fn().mockResolvedValue(ONE_PX_PNG_B64) } as unknown as WitnessDriver;
    await witness(driver, 'bare');
    expect(fs.existsSync(metaPath('bare'))).toBe(false);
  });
});
