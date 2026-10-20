/**
 * Capture health for the Playwright adapter: what failed to load (web fonts,
 * stylesheets, images, requests that answered 400 or more), read by the
 * shared probe in the page right AFTER the screenshot, so it sees what loaded,
 * and BEFORE the ignoreSelectors and stabilize styles come off: removing them
 * shows elements that were hidden in the capture, and a web font only such an
 * element uses starts loading then, for glyphs that were never in the image.
 * Merged into the capture's metadata.json as `health`; approving freezes it
 * into the baseline's. See capture/health.ts in @testivai/witness for the
 * shape and report/health.ts for when a capture is unhealthy.
 */
import { type BaselineStore, type CaptureHealth, HEALTH_PROBE_EXPRESSION, parseHealth } from '@testivai/witness';

/** The part of a Playwright Page this needs (structural, so tests need no browser). */
export interface EvaluatesExpressions {
  evaluate(expression: string): Promise<unknown>;
}

/**
 * Run the probe. Best-effort, like the rest of the metadata: a probe that
 * throws or returns something malformed gives null, which reads as "not
 * checked", never as healthy.
 */
export async function probeCaptureHealth(page: EvaluatesExpressions): Promise<CaptureHealth | null> {
  try {
    return parseHealth(await page.evaluate(HEALTH_PROBE_EXPRESSION));
  } catch {
    return null;
  }
}

/** Record a probe's result in the capture's metadata.json; nothing for null (not checked). */
export function recordCaptureHealth(store: BaselineStore, name: string, health: CaptureHealth | null): void {
  if (!health) return;
  try {
    store.writeTempMetadata(name, { health });
  } catch {
    // not checked: the screenshot path never depends on it
  }
}
