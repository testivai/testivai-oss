/**
 * On WebKit and Firefox there is no CDP, so witness() captures with
 * Playwright's own full-page screenshot. That is the expected path, not a
 * failure: no "Browser screenshot failed" on the console. A CDP failure on
 * Chromium is still reported.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import type { Page, TestInfo } from '@playwright/test';
import { BaselineStore } from '@testivai/witness';

import { snapshot } from '../../snapshot';

const png = () => sharp({ create: { width: 100, height: 50, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();

function fakePage(engine: 'webkit' | 'firefox' | 'chromium' | null, cdpError: string, calls: string[]): Page {
  const browser = engine === null ? null : { version: () => '1.0', browserType: () => ({ name: () => engine }) };
  const page = {
    url: () => 'http://localhost/home',
    viewportSize: () => ({ width: 100, height: 50 }),
    addStyleTag: async () => ({ evaluate: async () => {} }),
    waitForTimeout: async () => {},
    evaluate: async (arg: unknown) => (typeof arg === 'function' ? '<html><body></body></html>' : undefined),
    screenshot: async (opts: { path?: string }) => {
      calls.push('page.screenshot');
      const buf = await png();
      if (opts.path) fs.writeFileSync(opts.path, buf);
      return buf;
    },
    context: () => ({
      browser: () => browser,
      newCDPSession: async () => {
        calls.push('newCDPSession');
        throw new Error(cdpError);
      },
    }),
  };
  return page as unknown as Page;
}

describe('witness() on an engine without CDP', () => {
  let root: string;
  let errors: jest.SpyInstance;
  const info = { project: { name: 'iphone', use: {} }, titlePath: ['t'], title: 't', file: 'x.spec.ts' } as unknown as TestInfo;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-pw-nocdp-'));
    jest.spyOn(process, 'cwd').mockReturnValue(root);
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const CHROMIUM_ONLY = 'browserContext.newCDPSession: CDP session is only available in Chromium';

  it.each(['webkit', 'firefox'] as const)('%s: Playwright full-page screenshot, no CDP attempt, nothing on the console', async (engine) => {
    const calls: string[] = [];
    await snapshot(fakePage(engine, CHROMIUM_ONLY, calls), info, 'home');
    expect(calls).toEqual(['page.screenshot']);
    expect(errors).not.toHaveBeenCalled();
    expect(new BaselineStore(root).readTempMetadata('home')?.environment).toMatchObject({ adapter: { captureMethod: 'full-page:playwright' } });
  });

  it('unknown engine (a persistent context has no browser()): the Chromium-only answer is not an error either', async () => {
    const calls: string[] = [];
    await snapshot(fakePage(null, CHROMIUM_ONLY, calls), info, 'home');
    expect(calls).toEqual(['newCDPSession', 'page.screenshot']);
    expect(errors).not.toHaveBeenCalled();
  });

  it('Chromium whose CDP capture fails: still reported, then the fallback', async () => {
    const calls: string[] = [];
    await snapshot(fakePage('chromium', 'Target closed', calls), info, 'home');
    expect(calls).toEqual(['newCDPSession', 'page.screenshot']);
    expect(errors).toHaveBeenCalledWith('[TestivAI] Browser screenshot failed:', 'Target closed');
  });
});
