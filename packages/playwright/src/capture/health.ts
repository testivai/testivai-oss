/**
 * Capture health for the Playwright adapter: what failed to load (web fonts,
 * stylesheets, images, requests that answered 400 or more), read by the
 * shared probe in the page AFTER the capture, so it sees what loaded. Merged
 * into the capture's metadata.json as `health`; approving freezes it into the
 * baseline's. See capture/health.ts in @testivai/witness for the shape and
 * report/health.ts for when a capture is unhealthy.
 */
import { type BaselineStore, HEALTH_PROBE_EXPRESSION, parseHealth } from '@testivai/witness';

/** The part of a Playwright Page this needs (structural, so tests need no browser). */
export interface EvaluatesExpressions {
  evaluate(expression: string): Promise<unknown>;
}

/**
 * Run the probe and record its result. Best-effort, like the rest of the
 * metadata: a probe that throws or returns something malformed records
 * nothing, which reads as "not checked", never as healthy.
 */
export async function recordCaptureHealth(page: EvaluatesExpressions, store: BaselineStore, name: string): Promise<void> {
  try {
    const health = parseHealth(await page.evaluate(HEALTH_PROBE_EXPRESSION));
    if (health) store.writeTempMetadata(name, { health });
  } catch {
    // not checked: the screenshot path never depends on it
  }
}
