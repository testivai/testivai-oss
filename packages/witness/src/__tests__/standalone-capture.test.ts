import * as vm from 'vm';
import { captureFullPage } from '../standalone/run';
import { logger } from '../utils/logger';

interface EvaluateParams {
  expression: string;
  awaitPromise?: boolean;
}

interface Size {
  width: number;
  height: number;
}

interface FakeOptions {
  /** Replaces Runtime.evaluate's behavior; default: every in-page wait sees two frames. */
  evaluate?: (params: EvaluateParams) => Promise<unknown>;
  /** What getLayoutMetrics reports, call by call, repeating the last. */
  sizes?: Size[];
  /** What captureScreenshot returns, call by call, repeating the last. */
  shots?: string[];
}

/** A CDP client double that records the order of the calls captureFullPage makes. */
function fakeClient(options: FakeOptions = {}) {
  const sizes = options.sizes ?? [{ width: 1280, height: 2000 }];
  const shots = options.shots ?? ['png-bytes'];
  const calls: string[] = [];
  const evaluated: EvaluateParams[] = [];
  let measured = 0;
  let captured = 0;
  const client = {
    Runtime: {
      evaluate: jest.fn(async (params: EvaluateParams) => {
        evaluated.push(params);
        calls.push(params.awaitPromise ? 'evaluate:awaitPromise' : 'evaluate');
        return options.evaluate ? options.evaluate(params) : { result: { value: true } };
      }),
    },
    Page: {
      getLayoutMetrics: jest.fn(async () => {
        calls.push('getLayoutMetrics');
        const size = sizes[Math.min(measured++, sizes.length - 1)];
        return { cssContentSize: size, contentSize: size };
      }),
      captureScreenshot: jest.fn(async () => {
        calls.push('captureScreenshot');
        const shot = shots[Math.min(captured++, shots.length - 1)];
        return { data: Buffer.from(shot).toString('base64') };
      }),
    },
  };
  return { client, calls, evaluated };
}

/**
 * An evaluate double for the in-page frame wait: the nth wait resolves to
 * `results[n]` (true: two frames rendered, false: timed out), repeating the
 * last value.
 */
function frameWaits(results: boolean[]) {
  let waited = 0;
  return async (params: EvaluateParams) => {
    if (!params.awaitPromise) return { result: { value: true } };
    return { result: { value: results[Math.min(waited++, results.length - 1)] } };
  };
}

/** The calls up to and including the first screenshot. */
function untilFirstCapture(calls: string[]): string[] {
  return calls.slice(0, calls.indexOf('captureScreenshot') + 1);
}

/** The in-page script captureFullPage awaits before it measures and captures. */
async function frameWaitScript(): Promise<string> {
  const { client, evaluated } = fakeClient();
  await captureFullPage(client);
  const wait = evaluated.find((p) => p.awaitPromise);
  if (!wait) throw new Error('captureFullPage evaluated no awaited in-page script');
  return wait.expression;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('captureFullPage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('fresh frame wait', () => {
    it('waits for the page to render before measuring and capturing', async () => {
      const { client, calls } = fakeClient();

      await captureFullPage(client);

      const wait = calls.indexOf('evaluate:awaitPromise');
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(wait).toBeLessThan(calls.indexOf('getLayoutMetrics'));
      expect(wait).toBeLessThan(calls.indexOf('captureScreenshot'));
    });

    it('the in-page wait resolves only after two animation frames', async () => {
      const frames: Array<() => void> = [];
      let resolved = false;
      const pending = vm.runInNewContext(await frameWaitScript(), {
        requestAnimationFrame: (cb: () => void) => frames.push(cb),
        setTimeout: () => 0,
        clearTimeout: () => undefined,
      }) as Promise<unknown>;
      pending.then(() => {
        resolved = true;
      });

      await flush();
      expect(resolved).toBe(false);
      frames.shift()?.();
      await flush();
      expect(resolved).toBe(false); // one frame is not enough: it may not have painted yet
      frames.shift()?.();
      await flush();
      expect(resolved).toBe(true);
    });

    it('the in-page wait gives up after a bounded time when the page renders no frames', async () => {
      const timers: Array<{ cb: () => void; ms: number }> = [];
      let resolved = false;
      const pending = vm.runInNewContext(await frameWaitScript(), {
        requestAnimationFrame: () => 0, // never calls back
        setTimeout: (cb: () => void, ms: number) => timers.push({ cb, ms }),
        clearTimeout: () => undefined,
      }) as Promise<unknown>;
      pending.then(() => {
        resolved = true;
      });

      await flush();
      expect(resolved).toBe(false);
      expect(timers).toHaveLength(1);
      expect(timers[0].ms).toBeGreaterThan(0);
      expect(timers[0].ms).toBeLessThanOrEqual(2000);
      timers[0].cb();
      await flush();
      expect(resolved).toBe(true);
    });

    it('waits once before measuring when the page renders and measures straight away', async () => {
      const { client, calls } = fakeClient({ evaluate: frameWaits([true]) });

      await captureFullPage(client);

      expect(untilFirstCapture(calls)).toEqual(['evaluate:awaitPromise', 'getLayoutMetrics', 'captureScreenshot']);
    });

    it('retries the frame wait once when no fresh frame arrived in time', async () => {
      const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const { client, calls } = fakeClient({ evaluate: frameWaits([false, true]) });

      await captureFullPage(client);

      expect(untilFirstCapture(calls)).toEqual([
        'evaluate:awaitPromise', // timed out
        'evaluate:awaitPromise', // retry: two frames rendered
        'getLayoutMetrics',
        'captureScreenshot',
      ]);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith(expect.stringMatching(/no fresh frame.*waiting once more/i));
    });

    it('gives up after one retry, says so in the debug log, and still captures', async () => {
      const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const { client, calls } = fakeClient({ evaluate: frameWaits([false]) });

      await expect(captureFullPage(client)).resolves.toEqual(Buffer.from('png-bytes'));

      expect(untilFirstCapture(calls)).toEqual([
        'evaluate:awaitPromise',
        'evaluate:awaitPromise',
        'getLayoutMetrics',
        'captureScreenshot',
      ]);
      expect(debug).toHaveBeenLastCalledWith(expect.stringMatching(/no fresh frame after a retry.*may be stale/i));
    });

    it('logs nothing when the frames arrive and the captures match', async () => {
      const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const { client } = fakeClient({ evaluate: frameWaits([true]) });

      await captureFullPage(client);

      expect(debug).not.toHaveBeenCalled();
    });

    it('waits for a fresh frame again when the layout metrics needed polling', async () => {
      // A fresh Chrome can report zero-size content before its first real layout;
      // the frame the first wait saw predates that layout.
      const { client, calls } = fakeClient({
        evaluate: frameWaits([true]),
        sizes: [
          { width: 0, height: 0 },
          { width: 1280, height: 2000 },
        ],
      });

      await captureFullPage(client);

      expect(untilFirstCapture(calls)).toEqual([
        'evaluate:awaitPromise',
        'getLayoutMetrics', // 0x0
        'getLayoutMetrics', // usable
        'evaluate:awaitPromise', // a frame rendered after that layout
        'captureScreenshot',
      ]);
    });

    it('retries the frame wait after polling too, when it timed out', async () => {
      const { client, calls } = fakeClient({
        evaluate: frameWaits([true, false, true]),
        sizes: [
          { width: 0, height: 0 },
          { width: 1280, height: 2000 },
        ],
      });

      await captureFullPage(client);

      expect(untilFirstCapture(calls)).toEqual([
        'evaluate:awaitPromise',
        'getLayoutMetrics',
        'getLayoutMetrics',
        'evaluate:awaitPromise', // timed out
        'evaluate:awaitPromise', // retry
        'captureScreenshot',
      ]);
    });

    it('still captures when the in-page wait fails, e.g. the page navigated away', async () => {
      const { client, calls } = fakeClient({
        evaluate: async (params) => {
          if (params.awaitPromise) throw new Error('Execution context was destroyed');
          return { result: { value: true } };
        },
      });

      await expect(captureFullPage(client)).resolves.toEqual(Buffer.from('png-bytes'));
      expect(untilFirstCapture(calls)).toEqual([
        'evaluate:awaitPromise', // failed
        'evaluate:awaitPromise', // retried once, failed again
        'getLayoutMetrics',
        'captureScreenshot',
      ]);
    });
  });

  describe('capture stability', () => {
    // Chrome can hand Page.captureScreenshot an older frame even after two
    // fresh frames rendered (a pre-viewport-override layout, an entry
    // animation mid-way). It never did so twice in a row with the same pixels.

    it('captures twice and returns the capture once two in a row match', async () => {
      const { client, calls } = fakeClient({ shots: ['good'] });

      await expect(captureFullPage(client)).resolves.toEqual(Buffer.from('good'));

      expect(calls.filter((c) => c === 'captureScreenshot')).toHaveLength(2);
    });

    it('captures again when the first capture is stale, until two in a row match', async () => {
      const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const { client, calls } = fakeClient({ shots: ['stale', 'good', 'good'] });

      await expect(captureFullPage(client)).resolves.toEqual(Buffer.from('good'));

      expect(calls.filter((c) => c === 'captureScreenshot')).toHaveLength(3);
      expect(debug).toHaveBeenCalledWith(expect.stringMatching(/captures in a row differed/i));
    });

    it('catches a stale recapture too', async () => {
      const { client, calls } = fakeClient({ shots: ['good', 'stale', 'good', 'good'] });

      await expect(captureFullPage(client)).resolves.toEqual(Buffer.from('good'));

      expect(calls.filter((c) => c === 'captureScreenshot')).toHaveLength(4);
    });

    it('waits for a fresh frame before every recapture', async () => {
      const { client, calls } = fakeClient({ shots: ['stale', 'good', 'good'] });

      await captureFullPage(client);

      const afterMeasure = calls.slice(calls.lastIndexOf('getLayoutMetrics') + 1);
      expect(afterMeasure).toEqual([
        'captureScreenshot',
        'evaluate:awaitPromise',
        'captureScreenshot',
        'evaluate:awaitPromise',
        'captureScreenshot',
      ]);
    });

    it('stops after four captures when none matches the one before, keeping the last', async () => {
      // e.g. a page that never stops animating: bounded cost, still a capture.
      const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
      const { client, calls } = fakeClient({ shots: ['a', 'b', 'c', 'd', 'e'] });

      await expect(captureFullPage(client)).resolves.toEqual(Buffer.from('d'));

      expect(calls.filter((c) => c === 'captureScreenshot')).toHaveLength(4);
      expect(debug).toHaveBeenLastCalledWith(expect.stringMatching(/no two captures in a row matched/i));
    });

    it('captures every attempt with the clip it measured', async () => {
      const { client } = fakeClient({ shots: ['stale', 'good', 'good'], sizes: [{ width: 1280, height: 2688 }] });

      await captureFullPage(client);

      expect(client.Page.captureScreenshot).toHaveBeenCalledTimes(3);
      for (const [params] of client.Page.captureScreenshot.mock.calls as unknown as Array<[unknown]>) {
        expect(params).toEqual({
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 1280, height: 2688, scale: 1 },
        });
      }
    });
  });
});
