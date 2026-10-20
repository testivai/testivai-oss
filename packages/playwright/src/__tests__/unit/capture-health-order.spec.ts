/**
 * When witness() runs the capture-health probe: right after the screenshot,
 * while the ignoreSelectors and stabilize styles are still on the page.
 * Removing them shows elements that were hidden in the capture, and a web
 * font only such an element uses starts loading then: probed afterwards, the
 * capture read "web fonts still loading" (or "a failed web font") for glyphs
 * that were never in the image. Pinned for every capture path.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';
import type { Page, TestInfo } from '@playwright/test';
import { BaselineStore, HEALTH_PROBE_EXPRESSION } from '@testivai/witness';

/** The events of the capture under test, in order (the CDP capture is mocked, so it logs here too). */
const mockLog: string[] = [];

const png = () => sharp({ create: { width: 100, height: 50, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();

jest.mock('../../capture/full-page', () => ({
  captureFullPageScreenshot: async () => {
    mockLog.push('screenshot');
    const mockSharp = jest.requireActual('sharp');
    return mockSharp({ create: { width: 100, height: 50, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  },
}));

import { snapshot } from '../../snapshot';

const HEALTH = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};

type Path = 'cdp' | 'cdp-fallback' | 'stitch-single' | 'stitch-multi';

/** A Page that logs the events this test orders: style tags added and removed, screenshots, the probe. */
function fakePage(mode: Path, log: string[]): Page {
  const styleTag = (content: string) => {
    const kind = content.includes('display: none') || content.includes('visibility: hidden') ? 'ignore' : content.includes('animation') ? 'stabilize' : 'other';
    log.push(`add:${kind}`);
    return { evaluate: async () => { log.push(`remove:${kind}`); } };
  };
  const page = {
    url: () => 'http://localhost/home',
    viewportSize: () => ({ width: 100, height: 50 }),
    addStyleTag: async ({ content }: { content: string }) => styleTag(content),
    waitForTimeout: async () => {},
    evaluate: async (arg: unknown) => {
      if (arg === HEALTH_PROBE_EXPRESSION) {
        log.push('probe');
        return HEALTH;
      }
      if (typeof arg === 'string' && arg.includes('mainScrollable')) {
        const scrollHeight = mode === 'stitch-multi' ? 100 : 50;
        return { hasScrollable: false, scrollableId: null, scrollHeight, clientHeight: 50, scrollTop: 0 };
      }
      if (typeof arg === 'function') return '<html><body></body></html>';
      return undefined;
    },
    screenshot: async (opts: { path?: string }) => {
      log.push('screenshot');
      const buf = await png();
      if (opts.path) fs.writeFileSync(opts.path, buf);
      return buf;
    },
    context: () => ({
      browser: () => null,
      newCDPSession: async () => {
        if (mode === 'cdp-fallback') throw new Error('CDP unavailable');
        return { send: async () => ({}), detach: async () => {} };
      },
    }),
  };
  return page as unknown as Page;
}

describe('witness(): the capture-health probe runs before the hiding styles come off', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-pw-health-order-'));
    jest.spyOn(process, 'cwd').mockReturnValue(root);
    // the cdp-fallback path logs its CDP failure
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const paths: Array<[Path, boolean | undefined]> = [
    ['cdp', undefined],
    ['cdp-fallback', undefined],
    ['stitch-single', false],
    ['stitch-multi', false],
  ];

  it.each(paths)('%s: probe after the screenshot, before the ignore and stabilize styles are removed', async (mode, useBrowserCapture) => {
    const log = mockLog;
    log.length = 0;
    const info = { project: { name: 'chromium', use: {} }, titlePath: ['t'], title: 't', file: 'x.spec.ts' } as unknown as TestInfo;
    await snapshot(fakePage(mode, log), info, 'home', {
      ignoreSelectors: [{ selector: '#chat', mode: 'collapse' }],
      ...(useBrowserCapture === undefined ? {} : { useBrowserCapture }),
    });

    expect(log).toContain('add:ignore');
    expect(log).toContain('add:stabilize');
    const probe = log.indexOf('probe');
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(log.lastIndexOf('screenshot'));
    expect(probe).toBeLessThan(log.indexOf('remove:ignore'));
    expect(probe).toBeLessThan(log.indexOf('remove:stabilize'));
    // Still recorded in the capture's metadata.json, next to the provenance.
    const meta = new BaselineStore(root).readTempMetadata('home');
    expect(meta?.health).toEqual(HEALTH);
    expect(meta?.environment).toBeDefined();
  });
});
