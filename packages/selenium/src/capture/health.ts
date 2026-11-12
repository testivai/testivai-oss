/**
 * Capture health for a WebDriver adapter: what failed to load (web fonts,
 * stylesheets, images, requests that answered 400 or more), read by the
 * shared probe in the page right AFTER the screenshot, so it sees what loaded,
 * and BEFORE the capture style comes off: removing a style that hid an
 * element can start loading a web font only that element uses, for glyphs
 * that were never in the image. Recorded as `health` in the capture's
 * metadata.json; approving freezes it into the baseline's. See
 * capture/health.ts in @testivai/witness for the shape and report/health.ts
 * for when a capture is unhealthy.
 */
import { type BaselineStore, type CaptureHealth, HEALTH_PROBE_EXPRESSION, parseHealth } from '@testivai/witness';

/** The probe as WebDriver's Execute Script runs it: a function body that returns the expression's value. */
export const HEALTH_PROBE_SCRIPT = `return ${HEALTH_PROBE_EXPRESSION}`;

/**
 * Run the probe with the driver's script function. Best-effort, like the rest
 * of the metadata: a probe that throws or returns something malformed gives
 * null, which reads as "not checked", never as healthy.
 */
export async function probeCaptureHealth(run: (script: string) => Promise<unknown>): Promise<CaptureHealth | null> {
  try {
    return parseHealth(await run(HEALTH_PROBE_SCRIPT));
  } catch {
    return null;
  }
}

/**
 * Record a probe's result in the capture's metadata.json. A capture that could
 * not be checked records nothing, and drops a `health` an earlier run of the
 * same snapshot left there: metadata.json is merged, never cleared.
 */
export function recordCaptureHealth(store: BaselineStore, name: string, health: CaptureHealth | null): void {
  try {
    if (health) store.writeTempMetadata(name, { name, health });
    else if (store.readTempMetadata(name)?.health !== undefined) store.writeTempMetadata(name, { health: undefined });
  } catch {
    // not checked: the screenshot path never depends on it
  }
}
