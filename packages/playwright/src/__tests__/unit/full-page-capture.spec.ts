/**
 * Full-page capture stability.
 *
 * Chrome can hand Page.captureScreenshot a frame painted with styles resolved
 * against the wrong viewport while it sets up a beyond-viewport capture. On
 * testivai-site's CI, the home page's em-sized text was drawn at
 * `@media (max-width: 480px)` sizes (body 17px instead of 18px) in some
 * captures: the measured layout (element map) was identical to the baseline,
 * the pixels were 4.13% different, and the same commit passed on a re-run.
 * The standalone CLI already guards against this (fresh frame + capture
 * until two in a row match); these pin the same guard for the adapter.
 */

import type { CDPSession, Page } from '@playwright/test';
import { FRESH_FRAME_EXPRESSION } from '@testivai/witness';
import { captureFullPageScreenshot } from '../../capture/full-page';

interface Size {
  width: number;
  height: number;
}

interface FakeOptions {
  /** Result of each in-page frame wait in turn (true: two frames rendered), repeating the last. */
  frames?: boolean[];
  /** Makes every in-page frame wait throw, as when the page navigated away. */
  evaluateThrows?: boolean;
  /** What Page.getLayoutMetrics reports. */
  size?: Size;
  /** What Page.captureScreenshot returns, call by call, repeating the last. */
  shots?: string[];
}

function fakes(options: FakeOptions = {}) {
  const frames = options.frames ?? [true];
  const size = options.size ?? { width: 1280, height: 9652 };
  const shots = options.shots ?? ['png-bytes'];
  const calls: string[] = [];
  let waited = 0;
  let captured = 0;

  const page = {
    evaluate: jest.fn(async (expression: unknown) => {
      if (expression !== FRESH_FRAME_EXPRESSION) throw new Error(`unexpected evaluate: ${String(expression)}`);
      calls.push('frameWait');
      if (options.evaluateThrows) throw new Error('Execution context was destroyed');
      return frames[Math.min(waited++, frames.length - 1)];
    }),
  };

  const client = {
    send: jest.fn(async (method: string, _params?: unknown) => {
      calls.push(method);
      if (method === 'Page.getLayoutMetrics') {
        // contentSize is what the adapter has always measured; keep using it.
        return { contentSize: { x: 0, y: 0, ...size }, layoutViewport: { clientWidth: size.width, clientHeight: 720 } };
      }
      if (method === 'Page.captureScreenshot') {
        const shot = shots[Math.min(captured++, shots.length - 1)];
        return { data: Buffer.from(shot).toString('base64') };
      }
      throw new Error(`unexpected CDP call: ${method}`);
    }),
  };

  return {
    page: page as unknown as Page,
    client: client as unknown as CDPSession,
    pageMock: page,
    clientMock: client,
    calls,
  };
}

const capturesIn = (calls: string[]) => calls.filter((c) => c === 'Page.captureScreenshot').length;

describe('captureFullPageScreenshot', () => {
  describe('fresh frame wait', () => {
    it('waits for the page to render a fresh frame before measuring and capturing', async () => {
      const { page, client, calls } = fakes();

      await captureFullPageScreenshot(page, client);

      const wait = calls.indexOf('frameWait');
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(wait).toBeLessThan(calls.indexOf('Page.getLayoutMetrics'));
      expect(wait).toBeLessThan(calls.indexOf('Page.captureScreenshot'));
    });

    it('retries the frame wait once when no fresh frame arrived in time', async () => {
      const log = jest.fn();
      const { page, client, calls } = fakes({ frames: [false, true] });

      await captureFullPageScreenshot(page, client, log);

      const beforeMeasure = calls.slice(0, calls.indexOf('Page.getLayoutMetrics'));
      expect(beforeMeasure).toEqual(['frameWait', 'frameWait']);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/no fresh frame.*waiting once more/i));
    });

    it('still captures when no fresh frame arrives at all', async () => {
      const { page, client } = fakes({ frames: [false] });

      await expect(captureFullPageScreenshot(page, client)).resolves.toEqual(Buffer.from('png-bytes'));
    });

    it('still captures when the frame wait fails, e.g. the page navigated away', async () => {
      const { page, client } = fakes({ evaluateThrows: true });

      await expect(captureFullPageScreenshot(page, client)).resolves.toEqual(Buffer.from('png-bytes'));
    });
  });

  describe('capture stability', () => {
    it('captures twice and returns the capture once two in a row match', async () => {
      const { page, client, calls } = fakes({ shots: ['good'] });

      await expect(captureFullPageScreenshot(page, client)).resolves.toEqual(Buffer.from('good'));

      expect(capturesIn(calls)).toBe(2);
    });

    it('captures again when the first capture is stale, until two in a row match', async () => {
      // The testivai-site case: one capture drawn at narrow-viewport sizes.
      const log = jest.fn();
      const { page, client, calls } = fakes({ shots: ['narrow-viewport text', 'good', 'good'] });

      await expect(captureFullPageScreenshot(page, client, log)).resolves.toEqual(Buffer.from('good'));

      expect(capturesIn(calls)).toBe(3);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/two captures in a row differed/i));
    });

    it('catches a stale recapture too', async () => {
      const { page, client, calls } = fakes({ shots: ['good', 'stale', 'good', 'good'] });

      await expect(captureFullPageScreenshot(page, client)).resolves.toEqual(Buffer.from('good'));

      expect(capturesIn(calls)).toBe(4);
    });

    it('waits for a fresh frame before every recapture', async () => {
      const { page, client, calls } = fakes({ shots: ['stale', 'good', 'good'] });

      await captureFullPageScreenshot(page, client);

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
      const { page, client, calls } = fakes({ shots: ['a', 'b', 'c', 'd', 'e'] });

      await expect(captureFullPageScreenshot(page, client, log)).resolves.toEqual(Buffer.from('d'));

      expect(capturesIn(calls)).toBe(4);
      expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/no two captures in a row matched/i));
    });

    it('captures every attempt beyond the viewport with the clip it measured', async () => {
      const { page, client, clientMock } = fakes({
        shots: ['stale', 'good', 'good'],
        size: { width: 1280.4, height: 9651.2 },
      });

      await captureFullPageScreenshot(page, client);

      const shots = clientMock.send.mock.calls.filter(([method]) => method === 'Page.captureScreenshot');
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
      const { page, client, calls } = fakes({ shots: ['stale', 'good', 'good'] });

      await captureFullPageScreenshot(page, client);

      expect(calls.filter((c) => c === 'Page.getLayoutMetrics')).toHaveLength(1);
    });
  });
});
