import type { CDPSession, Page } from '@playwright/test';
import { FRESH_FRAME_EXPRESSION, captureUntilStable, settleFreshFrame, type CaptureLog } from '@testivai/witness';

/**
 * Full-page screenshot through CDP: wait for a fresh frame, measure the
 * content, then capture beyond the viewport until two captures in a row match
 * (at most MAX_STABLE_CAPTURES from @testivai/witness).
 *
 * Chrome can hand back a frame painted with styles resolved against the wrong
 * viewport while it sets up a beyond-viewport capture: on testivai-site's CI,
 * em-sized text on the home page was drawn at its `max-width: 480px` size in
 * some captures, so an unchanged page read as 4.13% changed while its measured
 * layout matched the baseline. See capture/stable-capture.ts in
 * @testivai/witness, which the standalone CLI shares.
 *
 * A stable page costs one extra screenshot.
 *
 * @param page The page being captured; used for the in-page frame wait.
 * @param client A CDP session attached to `page`.
 * @param log Optional debug sink.
 * @returns The PNG bytes of the kept capture.
 */
export async function captureFullPageScreenshot(page: Page, client: CDPSession, log?: CaptureLog): Promise<Buffer> {
  const waitOnce = async () => (await page.evaluate(FRESH_FRAME_EXPRESSION)) === true;
  const settle = () => settleFreshFrame(waitOnce, log);

  await settle();

  const layoutMetrics = await client.send('Page.getLayoutMetrics');
  const width = Math.ceil(layoutMetrics.contentSize.width);
  const height = Math.ceil(layoutMetrics.contentSize.height);
  log?.(
    `page ${width}x${height}, viewport ${layoutMetrics.layoutViewport?.clientWidth}x${layoutMetrics.layoutViewport?.clientHeight}`,
  );

  const data = await captureUntilStable({
    capture: async () =>
      (
        await client.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        })
      ).data,
    settle,
    log,
  });
  return Buffer.from(data, 'base64');
}
