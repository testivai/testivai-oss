import * as vm from 'vm';
import { captureFullPage } from '../standalone/run';

interface EvaluateParams {
  expression: string;
  awaitPromise?: boolean;
}

/** A CDP client double that records the order of the calls captureFullPage makes. */
function fakeClient(evaluate?: (params: EvaluateParams) => Promise<unknown>) {
  const calls: string[] = [];
  const evaluated: EvaluateParams[] = [];
  const client = {
    Runtime: {
      evaluate: jest.fn(async (params: EvaluateParams) => {
        evaluated.push(params);
        calls.push(params.awaitPromise ? 'evaluate:awaitPromise' : 'evaluate');
        return evaluate ? evaluate(params) : { result: { value: true } };
      }),
    },
    Page: {
      getLayoutMetrics: jest.fn(async () => {
        calls.push('getLayoutMetrics');
        return { cssContentSize: { width: 1280, height: 2000 }, contentSize: { width: 1280, height: 2000 } };
      }),
      captureScreenshot: jest.fn(async () => {
        calls.push('captureScreenshot');
        return { data: Buffer.from('png-bytes').toString('base64') };
      }),
    },
  };
  return { client, calls, evaluated };
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

  it('still captures when the in-page wait fails, e.g. the page navigated away', async () => {
    const { client, calls } = fakeClient(async (params) => {
      if (params.awaitPromise) throw new Error('Execution context was destroyed');
      return { result: { value: true } };
    });

    await expect(captureFullPage(client)).resolves.toEqual(Buffer.from('png-bytes'));
    expect(calls).toContain('captureScreenshot');
  });
});
