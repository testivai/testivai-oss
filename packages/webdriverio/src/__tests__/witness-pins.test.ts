/**
 * Pins for the capture() split. The web-page path of witness() is over the
 * repo's complexity limit and capture health has to go into it, so it is
 * split into helpers first. These tests fixed what it did, call by call, so
 * the split could not change it; the one call added since is the
 * capture-health probe, right after the screenshot. They pin: the order of the calls, a page that refuses
 * the style tag, stabilize off, a capture whose browser nothing names, a
 * browser without execute, and how the variant and environmentPolicy
 * "separate" key it.
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

interface Options {
  /** The render probe's user agent; null answers no user agent at all. */
  userAgent?: string | null;
  injectFails?: boolean;
  capabilities?: Record<string, unknown>;
}

/** A browser that records each script it runs as an event, in order. */
function loggingBrowser({ userAgent = CHROME_UA, injectFails = false, capabilities }: Options = {}) {
  const log: string[] = [];
  const execute = jest.fn(async (script: unknown) => {
    const s = String(script);
    if (s === `return ${HEALTH_PROBE_EXPRESSION}`) {
      log.push('health');
      return null;
    }
    if (s.includes('prefers-color-scheme')) {
      log.push('render');
      return userAgent === null ? { viewport: { width: 800, height: 600 } } : { viewport: { width: 800, height: 600 }, userAgent };
    }
    if (s.includes("createElement('style')")) {
      log.push('add_style');
      if (injectFails) throw new Error('CSP');
      return undefined;
    }
    if (s.includes('getElementById') && s.includes('remove')) {
      log.push('remove_style');
      return undefined;
    }
    if (s.includes("document.fonts.status : 'loaded'")) {
      log.push('fonts');
      return 'loaded';
    }
    if (s.includes('cloneNode')) {
      log.push('dom');
      return '<html><body></body></html>';
    }
    if (s.includes('collectElementMap')) {
      log.push('element_map');
      return null;
    }
    log.push('other');
    return undefined;
  });
  const browser: WitnessBrowser = {
    takeScreenshot: jest.fn(async () => {
      log.push('screenshot');
      return ONE_PX_PNG_B64;
    }),
    execute: execute as unknown as WitnessBrowser['execute'],
    ...(capabilities ? { capabilities } : {}),
  };
  return { browser, log };
}

describe('witness() on a page: pinned before the split', () => {
  let projectRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-wdio-pins-'));
    originalCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const temp = (...p: string[]) => path.join(projectRoot, '.testivai', 'temp', ...p);
  const writeConfig = (config: object) => {
    fs.mkdirSync(path.join(projectRoot, '.testivai'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.testivai', 'config.json'), JSON.stringify(config));
  };

  it('runs in this order: render probe, style, fonts, screenshot, style off, DOM, element map', async () => {
    const { browser, log } = loggingBrowser();
    await witness(browser, 'order');
    expect(log).toEqual(['render', 'add_style', 'fonts', 'screenshot', 'health', 'remove_style', 'dom', 'element_map']);
  });

  it('stabilize off with ignore selectors: the style goes on and off, with no font wait', async () => {
    const { browser, log } = loggingBrowser();
    await witness(browser, 'raw', { stabilize: false, ignoreSelectors: ['.ad'] });
    expect(log).toEqual(['render', 'add_style', 'screenshot', 'health', 'remove_style', 'dom', 'element_map']);
  });

  it('stabilize off and no ignore selectors: nothing is injected', async () => {
    const { browser, log } = loggingBrowser();
    await witness(browser, 'plain', { stabilize: false });
    expect(log).toEqual(['render', 'screenshot', 'health', 'dom', 'element_map']);
  });

  it('a page that refuses the style tag is still waited on, and nothing is removed', async () => {
    const { browser, log } = loggingBrowser({ injectFails: true });
    await witness(browser, 'locked');
    expect(log).toEqual(['render', 'add_style', 'fonts', 'screenshot', 'health', 'dom', 'element_map']);
    expect(fs.existsSync(temp('locked', 'screenshot.png'))).toBe(true);
  });

  it('writes no metadata.json when nothing names the browser', async () => {
    await witness(loggingBrowser({ userAgent: null }).browser, 'anon');
    expect(fs.existsSync(temp('anon', 'screenshot.png'))).toBe(true);
    expect(fs.existsSync(temp('anon', 'metadata.json'))).toBe(false);
  });

  it('a browser without execute gets the screenshot alone, and the environment from its capabilities', async () => {
    const browser = {
      takeScreenshot: jest.fn().mockResolvedValue(ONE_PX_PNG_B64),
      capabilities: { browserName: 'chrome', browserVersion: '141.0' },
    } as unknown as WitnessBrowser;
    await witness(browser, 'bare');
    expect(fs.existsSync(temp('bare', 'dom.html'))).toBe(false);
    expect(fs.existsSync(temp('bare', 'elements.json'))).toBe(false);
    const { environment } = JSON.parse(fs.readFileSync(temp('bare', 'metadata.json'), 'utf8'));
    expect(environment.browser).toEqual({ name: 'chromium', version: '141.0', channel: 'chrome' });
    expect(environment.render).toBeUndefined();
  });

  it('the variant comes before the environment key under environmentPolicy "separate"', async () => {
    writeConfig({ environmentPolicy: 'separate' });
    await witness(loggingBrowser().browser, 'home', { variant: 'Mobile Chrome' });
    expect(fs.existsSync(temp(`home__mobile_chrome__chromium__${process.platform}`, 'screenshot.png'))).toBe(true);
  });

  it('records the environment even when the DOM and the element map are skipped', async () => {
    await witness(loggingBrowser().browser, 'bare-page', { skipDom: true, skipElementMap: true });
    expect(JSON.parse(fs.readFileSync(temp('bare-page', 'metadata.json'), 'utf8')).environment.browser.name).toBe('chromium');
  });
});
