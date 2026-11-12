/**
 * Pins for the witness() split. witness() is over the repo's complexity limit
 * and capture health has to go into it, so it is split into helpers first.
 * These tests fixed what it did, call by call, so the split could not
 * change it; the one call added since is the capture-health probe, right
 * after the screenshot. They pin: the order of the calls, the settle options, the shard manifest,
 * a page that refuses the style tag, stabilize off, a capture whose browser
 * nothing names, and how the variant and environmentPolicy "separate" key it.
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

interface Options {
  /** The render probe's user agent; null answers no user agent at all. */
  userAgent?: string | null;
  injectFails?: boolean;
  /** The settle probe's answer. */
  settled?: boolean;
}

/** A driver that records each script it runs as an event, in order. */
function loggingDriver({ userAgent = FIREFOX_UA, injectFails = false, settled = true }: Options = {}) {
  const log: string[] = [];
  const scripts: string[] = [];
  const executeScript = jest.fn(async (script: string) => {
    scripts.push(script);
    if (script === `return ${HEALTH_PROBE_EXPRESSION}`) {
      log.push('health');
      return null;
    }
    if (script.includes('prefers-color-scheme')) {
      log.push('render');
      return userAgent === null ? { viewport: { width: 800, height: 600 } } : { viewport: { width: 800, height: 600 }, userAgent };
    }
    if (script.includes("createElement('style')")) {
      log.push('add_style');
      if (injectFails) throw new Error('CSP');
      return undefined;
    }
    if (script.includes('getElementById') && script.includes('remove')) {
      log.push('remove_style');
      return undefined;
    }
    if (script.includes("document.fonts.status !== 'loading'")) {
      log.push('fonts');
      return true;
    }
    if (script.includes('settleProbe')) {
      log.push('settle');
      return { settled };
    }
    if (script.includes('observer.disconnect')) {
      log.push('stop_settle');
      return undefined;
    }
    if (script.includes('cloneNode')) {
      log.push('dom');
      return '<html><body></body></html>';
    }
    if (script.includes('collectElementMap')) {
      log.push('element_map');
      return [];
    }
    log.push('other');
    return undefined;
  });
  const driver: WitnessDriver = {
    takeScreenshot: jest.fn(async () => {
      log.push('screenshot');
      return ONE_PX_PNG_B64;
    }),
    executeScript: executeScript as WitnessDriver['executeScript'],
  };
  return { driver, log, scripts };
}

describe('witness(): pinned before the split', () => {
  let projectRoot: string;
  let originalCwd: string;
  const savedShard = process.env.TESTIVAI_SHARD;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-selenium-pins-'));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
    delete process.env.TESTIVAI_SHARD;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
    if (savedShard === undefined) delete process.env.TESTIVAI_SHARD;
    else process.env.TESTIVAI_SHARD = savedShard;
  });

  const temp = (...p: string[]) => path.join(projectRoot, '.testivai', 'temp', ...p);
  const writeConfig = (config: object) => {
    fs.mkdirSync(path.join(projectRoot, '.testivai'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.testivai', 'config.json'), JSON.stringify(config));
  };

  it('runs in this order: render probe, style, fonts, settle, screenshot, style off, observer off, DOM, element map', async () => {
    const { driver, log } = loggingDriver();
    await witness(driver, 'order');
    expect(log).toEqual(['render', 'add_style', 'fonts', 'settle', 'screenshot', 'health', 'remove_style', 'stop_settle', 'dom', 'element_map']);
  });

  it('asks for the capabilities after the render probe, before the page is touched', async () => {
    const { driver, log } = loggingDriver();
    driver.getCapabilities = jest.fn(async () => {
      log.push('capabilities');
      return { get: () => undefined };
    }) as WitnessDriver['getCapabilities'];
    await witness(driver, 'caps');
    expect(log.slice(0, 3)).toEqual(['render', 'capabilities', 'add_style']);
  });

  it('stabilize off with ignore selectors: the style goes on and off, with no font or settle wait', async () => {
    const { driver, log } = loggingDriver();
    await witness(driver, 'raw', { stabilize: false, ignoreSelectors: ['.ad'] });
    expect(log).toEqual(['render', 'add_style', 'screenshot', 'health', 'remove_style', 'dom', 'element_map']);
  });

  it('stabilize off and no ignore selectors: nothing is injected', async () => {
    const { driver, log } = loggingDriver();
    await witness(driver, 'plain', { stabilize: false });
    expect(log).toEqual(['render', 'screenshot', 'health', 'dom', 'element_map']);
  });

  it('a page that refuses the style tag is still waited on, and nothing is removed', async () => {
    const { driver, log } = loggingDriver({ injectFails: true });
    await witness(driver, 'locked');
    expect(log).toEqual(['render', 'add_style', 'fonts', 'settle', 'screenshot', 'health', 'stop_settle', 'dom', 'element_map']);
    expect(fs.existsSync(temp('locked', 'screenshot.png'))).toBe(true);
  });

  it('passes settleQuietMs to the settle probe and polls it until settleTimeoutMs', async () => {
    const { driver, log, scripts } = loggingDriver({ settled: false });
    const started = Date.now();
    await witness(driver, 'slow', { settleQuietMs: 321, settleTimeoutMs: 120 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(scripts.find((s) => s.includes('settleProbe'))).toMatch(/, 321\)$/);
    expect(log.filter((e) => e === 'settle').length).toBeGreaterThanOrEqual(2);
  });

  it('refreshes the shard manifest on every capture when TESTIVAI_SHARD is set', async () => {
    process.env.TESTIVAI_SHARD = '2/3';
    await witness(loggingDriver().driver, 'one');
    await witness(loggingDriver().driver, 'two');
    const manifest = JSON.parse(fs.readFileSync(temp('testivai-shard.json'), 'utf8'));
    expect(manifest.shard).toEqual({ current: 2, total: 3 });
    expect(manifest.captures).toEqual(['one', 'two']);
    expect(manifest.complete).toBe(false);
  });

  it('writes no shard manifest without TESTIVAI_SHARD', async () => {
    await witness(loggingDriver().driver, 'one');
    expect(fs.existsSync(temp('testivai-shard.json'))).toBe(false);
  });

  it('writes no metadata.json when nothing names the browser', async () => {
    await witness(loggingDriver({ userAgent: null }).driver, 'anon');
    expect(fs.existsSync(temp('anon', 'screenshot.png'))).toBe(true);
    expect(fs.existsSync(temp('anon', 'metadata.json'))).toBe(false);
  });

  it('capabilities that throw fall back to the user agent', async () => {
    const { driver } = loggingDriver();
    driver.getCapabilities = jest.fn().mockRejectedValue(new Error('session gone'));
    await witness(driver, 'ua');
    expect(JSON.parse(fs.readFileSync(temp('ua', 'metadata.json'), 'utf8')).environment.browser).toEqual({ name: 'firefox', version: '143.0' });
  });

  it('a driver without executeScript gets the screenshot alone, and the environment from its capabilities', async () => {
    const driver: WitnessDriver = {
      takeScreenshot: jest.fn().mockResolvedValue(ONE_PX_PNG_B64),
      getCapabilities: jest.fn().mockResolvedValue({ get: (k: string) => ({ browserName: 'chrome', browserVersion: '141.0' })[k] }),
    } as unknown as WitnessDriver;
    await witness(driver, 'bare');
    expect(fs.existsSync(temp('bare', 'dom.html'))).toBe(false);
    expect(fs.existsSync(temp('bare', 'elements.json'))).toBe(false);
    const { environment } = JSON.parse(fs.readFileSync(temp('bare', 'metadata.json'), 'utf8'));
    expect(environment.browser).toEqual({ name: 'chromium', version: '141.0', channel: 'chrome' });
    expect(environment.render).toBeUndefined();
  });

  it('the variant comes before the environment key under environmentPolicy "separate"', async () => {
    writeConfig({ environmentPolicy: 'separate' });
    await witness(loggingDriver().driver, 'home', { variant: 'Mobile Chrome' });
    expect(fs.existsSync(temp(`home__mobile_chrome__firefox__${process.platform}`, 'screenshot.png'))).toBe(true);
  });
});
