/**
 * Full-page capture stability.
 *
 * Chrome can hand Page.captureScreenshot a frame painted with styles resolved
 * against the wrong viewport while it sets up a beyond-viewport capture
 * (narrow-viewport media rules, a collapsed 100vh hero, em text drawn at a
 * `max-width: 480px` body size). The page measures correctly but the pixels
 * do not, so an unchanged page flips between "changed" and "passed" across
 * runs. The standalone CLI and the Playwright adapter guard against this with
 * the shared helpers in @testivai/witness (fresh frame, then capture until two
 * in a row match); these pin the same guard for the Selenium adapter, which
 * reaches the page only through `sendAndGetDevToolsCommand`.
 */

import { FRESH_FRAME_EXPRESSION } from '@testivai/witness';
import { captureFullPageScreenshot } from '../capture/full-page';

interface Size {
  width: number;
  height: number;
}

interface FakeOptions {
  /** Result of each in-page frame wait in turn (true: two frames rendered), repeating the last. */
  frames?: boolean[];
  /** Makes every frame wait reject, as when the page navigated away mid-wait. */
  evaluateThrows?: boolean;
  /** What Page.getLayoutMetrics reports as cssContentSize (CSS pixels); omitted when null. */
  cssSize?: Size | null;
  /** What Page.getLayoutMetrics reports as the deprecated contentSize. Default: cssSize. */
  contentSize?: Size;
  /** What Page.captureScreenshot returns as data, call by call, repeating the last. */
  shots?: string[];
}

type Params = Record<string, unknown> | undefined;

function fakes(options: FakeOptions = {}) {
  const frames = options.frames ?? [true];
  const cssSize = options.cssSize === undefined ? { width: 1280, height: 9652 } : options.cssSize;
  const contentSize = options.contentSize ?? cssSize ?? { width: 1280, height: 9652 };
  const shots = options.shots ?? ['png-bytes'];
  const calls: string[] = [];
  let waited = 0;
  let captured = 0;

  // Answers like chromedriver's /goog/cdp/execute: the raw CDP result object.
  // Promise<any>: assignable to WitnessDriver's generic `Promise<T>` return.
  const sendAndGetDevToolsCommand = jest.fn(async (cmd: string, params?: Params): Promise<any> => {
    if (cmd === 'Runtime.evaluate') {
      if (params?.expression !== FRESH_FRAME_EXPRESSION) {
        throw new Error(`unexpected evaluate: ${String(params?.expression)}`);
      }
      calls.push('frameWait');
      if (options.evaluateThrows) throw new Error('Execution context was destroyed');
      // Without awaitPromise, CDP hands back the pending promise, not its value.
      if (params.awaitPromise !== true) {
        return { result: { type: 'object', subtype: 'promise', objectId: 'promise-1' } };
      }
      return { result: { type: 'boolean', value: frames[Math.min(waited++, frames.length - 1)] } };
    }
    calls.push(cmd);
    if (cmd === 'Page.getLayoutMetrics') {
      return {
        ...(cssSize ? { cssContentSize: { x: 0, y: 0, ...cssSize } } : {}),
        contentSize: { x: 0, y: 0, ...contentSize },
        cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
      };
    }
    if (cmd === 'Page.captureScreenshot') {
      const shot = shots[Math.min(captured++, shots.length - 1)];
      return { data: Buffer.from(shot).toString('base64') };
    }
    throw new Error(`unexpected CDP call: ${cmd}`);
  });

  return { driver: { sendAndGetDevToolsCommand }, cdp: sendAndGetDevToolsCommand, calls };
}

const capturesIn = (calls: string[]) => calls.filter((c) => c === 'Page.captureScreenshot').length;

describe('captureFullPageScreenshot', () => {
  describe('fresh frame wait', () => {
    it('waits for the page to render a fresh frame before measuring and capturing', async () => {
      const { driver, calls } = fakes();

      await captureFullPageScreenshot(driver);

      const wait = calls.indexOf('frameWait');
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(wait).toBeLessThan(calls.indexOf('Page.getLayoutMetrics'));
      expect(wait).toBeLessThan(calls.indexOf('Page.captureScreenshot'));
    });

    it('evaluates the shared frame wait through CDP and awaits its promise', async () => {
      const { driver, cdp } = fakes();

      await captureFullPageScreenshot(driver);

      expect(cdp).toHaveBeenCalledWith('Runtime.evaluate', {
        expression: FRESH_FRAME_EXPRESSION,
        awaitPromise: true,
        returnByValue: true,
      });
    });

    it('retries the frame wait once when no fresh frame arrived in time', async () => {
      const log = jest.fn();
      const { driver, calls } = fakes({ frames: [false, true] });

      await captureFullPageScreenshot(driver, log);

      const beforeMeasure = calls.slice(0, calls.indexOf('Page.getLayoutMetrics'));
      expect(beforeMeasure).toEqual(['frameWait', 'frameWait']);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/no fresh frame.*waiting once more/i));
    });

    it('still captures when no fresh frame arrives at all', async () => {
      const { driver } = fakes({ frames: [false] });

      await expect(captureFullPageScreenshot(driver)).resolves.toEqual(Buffer.from('png-bytes'));
    });

    it('still captures when the frame wait fails, e.g. the page navigated away', async () => {
      const { driver } = fakes({ evaluateThrows: true });

      await expect(captureFullPageScreenshot(driver)).resolves.toEqual(Buffer.from('png-bytes'));
    });
  });

  describe('capture stability', () => {
    it('captures twice and returns the capture once two in a row match', async () => {
      const { driver, calls } = fakes({ shots: ['good'] });

      await expect(captureFullPageScreenshot(driver)).resolves.toEqual(Buffer.from('good'));

      expect(capturesIn(calls)).toBe(2);
    });

    it('captures again when the first capture is stale, until two in a row match', async () => {
      // One capture painted for a narrow viewport (em text at the 480px body size).
      const log = jest.fn();
      const { driver, calls } = fakes({ shots: ['narrow-viewport text', 'good', 'good'] });

      await expect(captureFullPageScreenshot(driver, log)).resolves.toEqual(Buffer.from('good'));

      expect(capturesIn(calls)).toBe(3);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/two captures in a row differed/i));
    });

    it('catches a stale recapture too', async () => {
      const { driver, calls } = fakes({ shots: ['good', 'stale', 'good', 'good'] });

      await expect(captureFullPageScreenshot(driver)).resolves.toEqual(Buffer.from('good'));

      expect(capturesIn(calls)).toBe(4);
    });

    it('waits for a fresh frame before every recapture', async () => {
      const { driver, calls } = fakes({ shots: ['stale', 'good', 'good'] });

      await captureFullPageScreenshot(driver);

      const afterMeasure = calls.slice(calls.lastIndexOf('Page.getLayoutMetrics') + 1);
      expect(afterMeasure).toEqual([
        'Page.captureScreenshot',
        'frameWait',
        'Page.captureScreenshot',
        'frameWait',
        'Page.captureScreenshot',
      ]);
    });

    it('stops after four captures when none matches the one before, keeping the last', async () => {
      const log = jest.fn();
      const { driver, calls } = fakes({ shots: ['a', 'b', 'c', 'd', 'e'] });

      await expect(captureFullPageScreenshot(driver, log)).resolves.toEqual(Buffer.from('d'));

      expect(capturesIn(calls)).toBe(4);
      expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/no two captures in a row matched/i));
    });

    it('captures every attempt beyond the viewport with the clip it measured', async () => {
      const { driver, cdp } = fakes({
        shots: ['stale', 'good', 'good'],
        cssSize: { width: 1280.4, height: 9651.2 },
      });

      await captureFullPageScreenshot(driver);

      const shots = cdp.mock.calls.filter(([cmd]) => cmd === 'Page.captureScreenshot');
      expect(shots).toHaveLength(3);
      for (const [, params] of shots) {
        expect(params).toEqual({
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 1281, height: 9652, scale: 1 },
        });
      }
    });

    it('measures the page once', async () => {
      const { driver, calls } = fakes({ shots: ['stale', 'good', 'good'] });

      await captureFullPageScreenshot(driver);

      expect(calls.filter((c) => c === 'Page.getLayoutMetrics')).toHaveLength(1);
    });
  });

  describe('measurement', () => {
    it('clips in CSS pixels, not the device pixels contentSize reports on a HiDPI screen', async () => {
      const { driver, cdp } = fakes({
        cssSize: { width: 1280, height: 4826 },
        contentSize: { width: 2560, height: 9652 },
      });

      await captureFullPageScreenshot(driver);

      const [, params] = cdp.mock.calls.find(([cmd]) => cmd === 'Page.captureScreenshot') ?? [];
      expect(params).toMatchObject({ clip: { x: 0, y: 0, width: 1280, height: 4826, scale: 1 } });
    });

    it('falls back to contentSize on a Chrome that does not report cssContentSize', async () => {
      const { driver, cdp } = fakes({ cssSize: null, contentSize: { width: 1280, height: 3000 } });

      await captureFullPageScreenshot(driver);

      const [, params] = cdp.mock.calls.find(([cmd]) => cmd === 'Page.captureScreenshot') ?? [];
      expect(params).toMatchObject({ clip: { x: 0, y: 0, width: 1280, height: 3000, scale: 1 } });
    });

    it('fails rather than capture when the page reports no usable size', async () => {
      const { driver, calls } = fakes({ cssSize: { width: 0, height: 0 } });

      await expect(captureFullPageScreenshot(driver)).rejects.toThrow(/content size/i);
      expect(capturesIn(calls)).toBe(0);
    });

    it('sends a params object with every CDP command (older selenium-webdriver has no default)', async () => {
      const { driver, cdp } = fakes();

      await captureFullPageScreenshot(driver);

      for (const [, params] of cdp.mock.calls) {
        expect(params).toEqual(expect.any(Object));
      }
    });
  });

  it('fails when a capture returns no data, so the caller can fall back', async () => {
    const { driver } = fakes({ shots: [''] });

    await expect(captureFullPageScreenshot(driver)).rejects.toThrow(/no data/i);
  });
});
