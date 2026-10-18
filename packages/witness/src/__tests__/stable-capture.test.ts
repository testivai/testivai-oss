import * as vm from 'vm';
import {
  FRESH_FRAME_EXPRESSION,
  MAX_STABLE_CAPTURES,
  captureUntilStable,
  settleFreshFrame,
} from '../capture/stable-capture';
import * as witness from '../index';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A capture double returning `shots` in order, repeating the last. */
function captures(shots: string[]) {
  let n = 0;
  const capture = jest.fn(async () => shots[Math.min(n++, shots.length - 1)]);
  return capture;
}

describe('FRESH_FRAME_EXPRESSION', () => {
  it('resolves true only after two animation frames', async () => {
    const frames: Array<() => void> = [];
    let value: unknown;
    const pending = vm.runInNewContext(FRESH_FRAME_EXPRESSION, {
      requestAnimationFrame: (cb: () => void) => frames.push(cb),
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    }) as Promise<unknown>;
    pending.then((v) => {
      value = v;
    });

    await flush();
    expect(value).toBeUndefined();
    frames.shift()?.();
    await flush();
    expect(value).toBeUndefined(); // one frame may not have painted yet
    frames.shift()?.();
    await flush();
    expect(value).toBe(true);
  });

  it('resolves false after a bounded time when the page renders no frames', async () => {
    const timers: Array<{ cb: () => void; ms: number }> = [];
    let value: unknown;
    const pending = vm.runInNewContext(FRESH_FRAME_EXPRESSION, {
      requestAnimationFrame: () => 0, // never calls back
      setTimeout: (cb: () => void, ms: number) => timers.push({ cb, ms }),
      clearTimeout: () => undefined,
    }) as Promise<unknown>;
    pending.then((v) => {
      value = v;
    });

    await flush();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBeGreaterThan(0);
    expect(timers[0].ms).toBeLessThanOrEqual(2000);
    timers[0].cb();
    await flush();
    expect(value).toBe(false);
  });
});

describe('settleFreshFrame', () => {
  it('waits once when a fresh frame arrives, and logs nothing', async () => {
    const wait = jest.fn(async () => true);
    const log = jest.fn();

    await settleFreshFrame(wait, log);

    expect(wait).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('waits once more when no fresh frame arrived in time', async () => {
    const wait = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const log = jest.fn();

    await settleFreshFrame(wait, log);

    expect(wait).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no fresh frame.*waiting once more/i));
  });

  it('gives up after one retry and says the capture may be stale, without throwing', async () => {
    const wait = jest.fn(async () => false);
    const log = jest.fn();

    await expect(settleFreshFrame(wait, log)).resolves.toBeUndefined();

    expect(wait).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/capturing anyway.*may be stale/i));
  });

  it('treats a wait that throws (the page navigated away) as no frame, never as an error', async () => {
    const wait = jest.fn(async () => {
      throw new Error('Execution context was destroyed');
    });

    await expect(settleFreshFrame(wait)).resolves.toBeUndefined();
    expect(wait).toHaveBeenCalledTimes(2);
  });
});

describe('captureUntilStable', () => {
  it('captures twice and returns the capture once two in a row match', async () => {
    const capture = captures(['good']);
    const settle = jest.fn(async () => undefined);

    await expect(captureUntilStable({ capture, settle })).resolves.toBe('good');

    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('captures again when the first capture is stale, until two in a row match', async () => {
    const capture = captures(['stale', 'good', 'good']);
    const log = jest.fn();

    await expect(captureUntilStable({ capture, settle: async () => undefined, log })).resolves.toBe('good');

    expect(capture).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/two captures in a row differed/i));
  });

  it('catches a stale recapture too', async () => {
    const capture = captures(['good', 'stale', 'good', 'good']);

    await expect(captureUntilStable({ capture, settle: async () => undefined })).resolves.toBe('good');

    expect(capture).toHaveBeenCalledTimes(4);
  });

  it('settles before every recapture, not before the first capture', async () => {
    const order: string[] = [];
    const shots = ['stale', 'good', 'good'];
    let n = 0;

    await captureUntilStable({
      capture: async () => {
        order.push('capture');
        return shots[n++];
      },
      settle: async () => {
        order.push('settle');
      },
    });

    expect(order).toEqual(['capture', 'settle', 'capture', 'settle', 'capture']);
  });

  it(`stops after ${MAX_STABLE_CAPTURES} captures when none matches the one before, keeping the last`, async () => {
    // e.g. a page that never stops animating: bounded cost, still a capture.
    const capture = captures(['a', 'b', 'c', 'd', 'e']);
    const log = jest.fn();

    await expect(captureUntilStable({ capture, settle: async () => undefined, log })).resolves.toBe('d');

    expect(MAX_STABLE_CAPTURES).toBe(4);
    expect(capture).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/no two captures in a row matched in 4/i));
  });

  it('logs nothing when the first two captures match', async () => {
    const log = jest.fn();

    await captureUntilStable({ capture: captures(['good']), settle: async () => undefined, log });

    expect(log).not.toHaveBeenCalled();
  });

  it('compares with the given equality, e.g. for Buffers', async () => {
    const shots = [Buffer.from('stale'), Buffer.from('good'), Buffer.from('good')];
    let n = 0;

    const result = await captureUntilStable({
      capture: async () => shots[n++],
      settle: async () => undefined,
      same: (a, b) => a.equals(b),
    });

    expect(result.toString()).toBe('good');
    expect(n).toBe(3);
  });
});

describe('public exports', () => {
  it('are available from the package root for every adapter', () => {
    expect(witness.FRESH_FRAME_EXPRESSION).toBe(FRESH_FRAME_EXPRESSION);
    expect(witness.MAX_STABLE_CAPTURES).toBe(MAX_STABLE_CAPTURES);
    expect(witness.settleFreshFrame).toBe(settleFreshFrame);
    expect(witness.captureUntilStable).toBe(captureUntilStable);
  });
});
