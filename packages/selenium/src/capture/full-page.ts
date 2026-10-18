import { FRESH_FRAME_EXPRESSION, captureUntilStable, settleFreshFrame, type CaptureLog } from '@testivai/witness';
import type { WitnessDriver } from '../types';

/** A Chromium driver: one that can send raw CDP commands. */
export type CdpDriver = Required<Pick<WitnessDriver, 'sendAndGetDevToolsCommand'>>;

interface Size {
  width: number;
  height: number;
}

/** The parts of CDP `Page.getLayoutMetrics` this capture reads. */
interface LayoutMetrics {
  /** Scrollable area in CSS pixels, the unit of `Page.captureScreenshot`'s clip. */
  cssContentSize?: Size;
  /** Deprecated: in device pixels on newer Chrome, so only a fallback for Chrome that lacks cssContentSize. */
  contentSize?: Size;
  cssLayoutViewport?: { clientWidth: number; clientHeight: number };
}

/**
 * Full-page screenshot through CDP: wait for a fresh frame, measure the
 * content, then capture beyond the viewport until two captures in a row match
 * (at most MAX_STABLE_CAPTURES from @testivai/witness).
 *
 * Chrome can hand back a frame painted with styles resolved against the wrong
 * viewport while it sets up a beyond-viewport capture: narrow-viewport media
 * rules, a collapsed 100vh hero, or em text drawn at a `max-width: 480px`
 * body size. The page measures correctly but the pixels do not, so an
 * unchanged page flips between "changed" and "passed" across runs. See
 * capture/stable-capture.ts in @testivai/witness, which the standalone CLI
 * and the Playwright adapter share.
 *
 * Selenium reaches the page only through `sendAndGetDevToolsCommand`, so the
 * frame wait is CDP `Runtime.evaluate` with `awaitPromise`. Every command gets
 * an explicit params object instead of relying on the bindings' default.
 *
 * A stable page costs one extra screenshot.
 *
 * @param driver A Chromium (Chrome/Edge) driver.
 * @param log Optional debug sink.
 * @returns The PNG bytes of the kept capture.
 * @throws When the page reports no usable size or a capture returns no data,
 *   so the caller can fall back to a viewport screenshot.
 */
export async function captureFullPageScreenshot(driver: CdpDriver, log?: CaptureLog): Promise<Buffer> {
  const waitOnce = async () => {
    const evaluated = await driver.sendAndGetDevToolsCommand<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: FRESH_FRAME_EXPRESSION,
      awaitPromise: true,
      returnByValue: true,
    });
    return evaluated?.result?.value === true;
  };
  const settle = () => settleFreshFrame(waitOnce, log);

  await settle();

  const metrics = await driver.sendAndGetDevToolsCommand<LayoutMetrics>('Page.getLayoutMetrics', {});
  const size = metrics?.cssContentSize ?? metrics?.contentSize;
  const width = Math.ceil(size?.width ?? 0);
  const height = Math.ceil(size?.height ?? 0);
  if (!(width > 0 && height > 0)) {
    throw new Error(`page reported unusable content size ${width}x${height}`);
  }
  log?.(
    `page ${width}x${height}, viewport ${metrics.cssLayoutViewport?.clientWidth}x${metrics.cssLayoutViewport?.clientHeight}`,
  );

  const data = await captureUntilStable({
    capture: async () => {
      const shot = await driver.sendAndGetDevToolsCommand<{ data?: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      if (typeof shot?.data !== 'string' || shot.data.length === 0) {
        throw new Error('Page.captureScreenshot returned no data');
      }
      return shot.data;
    },
    settle,
    log,
  });
  return Buffer.from(data, 'base64');
}
