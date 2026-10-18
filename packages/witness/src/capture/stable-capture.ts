/**
 * Stable full-page capture — shared by every adapter that screenshots through
 * CDP `Page.captureScreenshot` with `captureBeyondViewport`.
 *
 * THE PROBLEM
 * -----------
 * Chrome can hand back a frame painted with styles resolved against the wrong
 * viewport while it sets up a beyond-viewport capture: narrow-viewport media
 * rules, a collapsed `min-height: 100vh` hero, or text sized from a
 * `@media (max-width: 480px)` body font. The page measures correctly (DOM,
 * element map and computed styles all match the baseline) but the pixels do
 * not, so an unchanged page flips between two renders from run to run and is
 * reported as changed. Measured on the standalone CLI (an e2e fixture failed
 * on nearly every attempt) and on a Playwright suite in CI (testivai-site's
 * home page: 4.13% "changed" on one run, the same commit passing on re-run).
 *
 * THE GUARD
 * ---------
 * 1. Wait for a fresh frame — two animation frames, so every style and layout
 *    change made so far has been painted — before measuring and capturing.
 *    A forced layout alone does not prevent a stale frame; a rendered one does.
 * 2. Capture until two captures in a row are identical, at most
 *    MAX_STABLE_CAPTURES. The capture after a wrong frame is almost always
 *    right. A stable page costs one extra screenshot; a page that never stops
 *    changing costs MAX_STABLE_CAPTURES, never an endless loop. The same wrong
 *    frame twice in a row would still be kept: rare, as it takes two misses.
 *
 * The helpers are transport-agnostic: the adapter supplies how to evaluate the
 * frame wait in its page and how to take one capture.
 */

/** How long the in-page frame wait waits for two frames before giving up. */
export const FRESH_FRAME_TIMEOUT_MS = 1000;

/**
 * In-page expression an adapter awaits before capturing: resolves `true` once
 * the page has rendered two animation frames (a frame produced after every
 * style and layout change made so far has been painted), or `false` after
 * FRESH_FRAME_TIMEOUT_MS for a page that renders no frames at all.
 */
export const FRESH_FRAME_EXPRESSION = `new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), ${FRESH_FRAME_TIMEOUT_MS});
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clearTimeout(timer);
    resolve(true);
  }));
})`;

/**
 * The most captures of one page while waiting for two in a row to match.
 * Every stale-capture pattern measured settles within four (stale, good,
 * good / good, stale, good, good).
 */
export const MAX_STABLE_CAPTURES = 4;

/** Where the helpers report what they did; adapters route it to their debug output. */
export type CaptureLog = (message: string) => void;

/**
 * Wait for a fresh frame, retrying once when none arrived in time (a loaded
 * machine can stall a frame past the in-page timeout). Best-effort, never
 * blocking and never throwing: if neither attempt sees a frame, the capture
 * proceeds and the log says it may be stale.
 *
 * @param waitOnce Evaluates FRESH_FRAME_EXPRESSION in the page and resolves
 *   whether it saw two frames. A rejection (e.g. the page navigated away)
 *   counts as no frame.
 * @param log Optional debug sink.
 */
export async function settleFreshFrame(waitOnce: () => Promise<boolean>, log?: CaptureLog): Promise<void> {
  const attempt = async (): Promise<boolean> => {
    try {
      return (await waitOnce()) === true;
    } catch {
      return false;
    }
  };
  if (await attempt()) return;
  log?.('no fresh frame within the wait; waiting once more');
  if (await attempt()) return;
  log?.('no fresh frame after a retry; capturing anyway, the screenshot may be stale');
}

/** Options for {@link captureUntilStable}. */
export interface CaptureUntilStableOptions<T> {
  /** Takes one capture of the page (e.g. base64 PNG data from CDP). */
  capture: () => Promise<T>;
  /** Runs before every recapture; typically `settleFreshFrame`. Not run before the first capture. */
  settle: () => Promise<void>;
  /** Whether two captures are the same pixels. Default: strict equality (right for base64 strings). */
  same?: (a: T, b: T) => boolean;
  /** Most captures to take. Default: MAX_STABLE_CAPTURES. */
  maxCaptures?: number;
  /** Optional debug sink. */
  log?: CaptureLog;
}

/**
 * Capture until two captures in a row match, at most `maxCaptures`, and return
 * the matching capture (or the last one when none matched the one before it).
 * The caller waits for a fresh frame before the first capture, usually before
 * measuring the page; this settles again before every recapture.
 */
export async function captureUntilStable<T>(options: CaptureUntilStableOptions<T>): Promise<T> {
  const { capture, settle, log } = options;
  const same = options.same ?? ((a: T, b: T) => a === b);
  const maxCaptures = options.maxCaptures ?? MAX_STABLE_CAPTURES;

  let previous = await capture();
  for (let captures = 1; captures < maxCaptures; captures++) {
    await settle();
    const current = await capture();
    if (same(current, previous)) return current;
    log?.('two captures in a row differed; capturing again');
    previous = current;
  }
  log?.(`no two captures in a row matched in ${maxCaptures}; keeping the last`);
  return previous;
}
