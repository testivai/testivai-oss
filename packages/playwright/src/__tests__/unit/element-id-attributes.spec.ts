/**
 * elementIdAttributes reaches the element map: witness() reads it from
 * .testivai/config.json, passes it to the page-side collector, and records
 * it in the capture's metadata.json (so the compare can tell paths built
 * another way). Unset, neither the collector call nor metadata.json changes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Page, TestInfo } from '@playwright/test';
import { BaselineStore } from '@testivai/witness';

jest.mock('../../capture/full-page', () => ({
  captureFullPageScreenshot: async () => {
    const mockSharp = jest.requireActual('sharp');
    return mockSharp({ create: { width: 100, height: 50, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  },
}));

import { snapshot } from '../../snapshot';

const MAP = [{ path: 'div[data-testid="board"]', x: 0, y: 0, width: 10, height: 10, styleHash: '00000000' }];

function fakePage(expressions: string[]): Page {
  const page = {
    url: () => 'http://localhost/home',
    viewportSize: () => ({ width: 100, height: 50 }),
    addStyleTag: async () => ({ evaluate: async () => {} }),
    waitForTimeout: async () => {},
    evaluate: async (arg: unknown) => {
      if (typeof arg === 'string' && arg.includes('function collectElementMap')) {
        expressions.push(arg);
        return MAP;
      }
      if (typeof arg === 'function') return '<html><body></body></html>';
      return undefined;
    },
    screenshot: async () => Buffer.alloc(0),
    context: () => ({
      browser: () => null,
      newCDPSession: async () => ({ send: async () => ({}), detach: async () => {} }),
    }),
  };
  return page as unknown as Page;
}

describe('witness(): elementIdAttributes', () => {
  let root: string;
  const info = { project: { name: 'chromium', use: {} }, titlePath: ['t'], title: 't', file: 'x.spec.ts' } as unknown as TestInfo;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-pw-ids-'));
    jest.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const config = (value: object) => {
    fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
    fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify(value));
  };

  it('unset: the collector gets no attribute list and metadata.json has no key', async () => {
    const expressions: string[] = [];
    await snapshot(fakePage(expressions), info, 'home');
    expect(expressions).toHaveLength(1);
    expect(expressions[0].endsWith(')(document, window, 3000, [])')).toBe(true);
    const meta = new BaselineStore(root).readTempMetadata('home');
    expect(meta && 'elementIdAttributes' in meta).toBe(false);
  });

  it('set in config.json: passed to the collector and recorded in metadata.json', async () => {
    config({ elementIdAttributes: ['data-testid', 'data-test'] });
    const expressions: string[] = [];
    await snapshot(fakePage(expressions), info, 'home');
    expect(expressions[0].endsWith(')(document, window, 3000, [], ["data-testid","data-test"])')).toBe(true);
    expect(new BaselineStore(root).readTempMetadata('home')?.elementIdAttributes).toEqual(['data-testid', 'data-test']);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.testivai', 'temp', 'home', 'elements.json'), 'utf-8'))).toEqual(MAP);
  });

  it('invalid names are dropped; an empty result is the same as unset', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    config({ elementIdAttributes: ['data test'] });
    const expressions: string[] = [];
    await snapshot(fakePage(expressions), info, 'home');
    expect(expressions[0].endsWith(')(document, window, 3000, [])')).toBe(true);
    const meta = new BaselineStore(root).readTempMetadata('home');
    expect(meta && 'elementIdAttributes' in meta).toBe(false);
  });
});
