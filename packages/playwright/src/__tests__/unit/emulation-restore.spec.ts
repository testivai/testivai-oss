/**
 * Chrome's beyond-viewport capture (the default full-page path, over a CDP
 * session of our own) drops the page's device emulation: measured on the
 * Pixel 7 profile, devicePixelRatio went 2.625 → 1 and touch emulation off
 * (maxTouchPoints 1 → 0, pointer: coarse false) for the rest of the test.
 * witness() restores what the capture dropped, after everything it measures
 * in the page (the element map is aligned with the 1× image), and records
 * the scale the image was rendered at.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Page, TestInfo } from '@playwright/test';
import { BaselineStore, RENDER_PROBE_EXPRESSION } from '@testivai/witness';

interface State { dpr: number; touch: number; coarse?: boolean; calls: string[] }
const mockState: { current: State | null } = { current: null };

jest.mock('../../capture/full-page', () => ({
  captureFullPageScreenshot: async () => {
    const s = mockState.current!;
    s.calls.push('capture');
    if (s.dpr !== 1 || s.touch !== 0) {
      // What Chrome does to the page's emulation.
      s.dpr = 1;
      s.touch = 0;
      s.coarse = false;
    }
    const mockSharp = jest.requireActual('sharp');
    return mockSharp({ create: { width: 100, height: 50, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  },
}));

import { snapshot } from '../../snapshot';
import { EMULATION_PROBE } from '../../capture/emulation';

function fakePage(state: State): Page {
  let sessions = 0;
  let size = { width: 412, height: 839 };
  // Like Playwright: a size equal to the last one set is not sent again.
  let lastSent = '412x839';
  const page = {
    url: () => 'http://localhost/home',
    viewportSize: () => size,
    setViewportSize: async (vp: { width: number; height: number }) => {
      size = vp;
      const key = `${vp.width}x${vp.height}`;
      if (key === lastSent) return;
      lastSent = key;
      state.calls.push(`setViewportSize:${key}`);
      state.dpr = 2.625;
      // As in the Chrome on CI: `pointer: coarse` is worked out when the
      // device metrics are applied, from the touch emulation at that moment.
      state.coarse = state.touch > 0;
    },
    addStyleTag: async () => ({ evaluate: async () => {} }),
    waitForTimeout: async () => {},
    evaluate: async (arg: unknown) => {
      if (arg === EMULATION_PROBE) return { dpr: state.dpr, maxTouchPoints: state.touch, coarsePointer: state.coarse ?? false };
      if (arg === RENDER_PROBE_EXPRESSION) return { viewport: { width: 412, height: 839 }, deviceScaleFactor: state.dpr };
      if (typeof arg === 'string' && arg.includes('function collectElementMap')) {
        state.calls.push(`elementMap@dpr${state.dpr}`);
        return [{ path: 'body', x: 0, y: 0, width: 100, height: 50, styleHash: '0' }];
      }
      if (typeof arg === 'function') return '<html><body></body></html>';
      return undefined;
    },
    screenshot: async () => Buffer.alloc(0),
    context: () => ({
      browser: () => null,
      newCDPSession: async () => {
        const id = ++sessions;
        return {
          send: async (method: string, params?: { enabled: boolean; maxTouchPoints: number }) => {
            if (method === 'Emulation.setTouchEmulationEnabled' && params) {
              state.calls.push(`session${id}:touch:${params.enabled}:${params.maxTouchPoints}`);
              state.touch = params.enabled ? params.maxTouchPoints : 0;
            }
            return {};
          },
          detach: async () => state.calls.push(`session${id}:detach`),
        };
      },
    }),
  };
  return page as unknown as Page;
}

/** The ids of the sessions that turned touch emulation back on. */
const touchSessions = (calls: string[]) => [...new Set(calls.filter((c) => /:touch:/.test(c)).map((c) => c.split(':')[0]))];

describe('witness(): device emulation after a CDP capture', () => {
  let root: string;
  const info = { project: { name: 'pixel-7', use: {} }, titlePath: ['t'], title: 't', file: 'x.spec.ts' } as unknown as TestInfo;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-pw-emulation-'));
    jest.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a phone profile: pixel ratio and touch restored after the element map; metadata records the 1× capture', async () => {
    const state: State = { dpr: 2.625, touch: 1, coarse: true, calls: [] };
    mockState.current = state;
    await snapshot(fakePage(state), info, 'home');

    expect(state.dpr).toBe(2.625);
    expect(state.touch).toBe(1);
    expect(state.coarse).toBe(true);
    const map = state.calls.indexOf('elementMap@dpr1');
    expect(map).toBeGreaterThan(-1);
    expect(state.calls.indexOf('setViewportSize:412x839')).toBeGreaterThan(map);
    const [touch] = touchSessions(state.calls);
    expect(state.calls).toContain(`${touch}:touch:true:1`);
    // The touch session stays attached: detaching it would clear the emulation again.
    expect(state.calls).not.toContain(`${touch}:detach`);

    const env = new BaselineStore(root).readTempMetadata('home')?.environment as { render?: { deviceScaleFactor?: number } };
    expect(env.render?.deviceScaleFactor).toBe(1);
  });

  it('a desktop profile the capture leaves alone: nothing restored, metadata unchanged', async () => {
    const state: State = { dpr: 1, touch: 0, calls: [] };
    mockState.current = state;
    await snapshot(fakePage(state), info, 'home');
    expect(state.calls.filter((c) => c.startsWith('setViewportSize') || /:touch:/.test(c))).toEqual([]);
    const env = new BaselineStore(root).readTempMetadata('home')?.environment as { render?: { deviceScaleFactor?: number } };
    expect(env.render?.deviceScaleFactor).toBe(1);
  });

  it('two captures in one test: the second is taken under the restored emulation and records the same scale', async () => {
    const state: State = { dpr: 2.625, touch: 1, coarse: true, calls: [] };
    mockState.current = state;
    const page = fakePage(state);
    await snapshot(page, info, 'first');
    await snapshot(page, info, 'second');
    expect(state.calls.filter((c) => c === 'capture')).toHaveLength(2);
    expect(state.dpr).toBe(2.625);
    expect(state.touch).toBe(1);
    expect(state.coarse).toBe(true);
    // One session restores touch for the page, reused by the second capture.
    expect(touchSessions(state.calls)).toHaveLength(1);
    const store = new BaselineStore(root);
    const dsf = (name: string) =>
      (store.readTempMetadata(name)?.environment as { render?: { deviceScaleFactor?: number } } | undefined)?.render?.deviceScaleFactor;
    expect([dsf('first'), dsf('second')]).toEqual([1, 1]);
  });
});
