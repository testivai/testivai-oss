import type { CDPSession, Page } from '@playwright/test';

/**
 * Device emulation around the default full-page capture.
 *
 * The capture runs `Page.captureScreenshot` with `captureBeyondViewport` over
 * a CDP session of our own. Chrome resizes the page for it and afterwards
 * restores that session's emulation, which is none: the device emulation
 * Playwright set on its own session is gone. Measured on the Pixel 7 profile:
 * devicePixelRatio 2.625 → 1 and the touch pointer gone (`pointer: coarse`
 * and `hover: none` false; maxTouchPoints 1 → 0 on Chrome 153, kept on
 * Chrome 156) for the rest of the test. The image itself is
 * rendered at a pixel ratio of 1 (412 px wide for a 412 px viewport).
 *
 * witness() reads the emulation before and right after the capture, records
 * the pixel ratio the image was rendered at, and restores what the capture
 * dropped once it has measured everything else in the page (the element map
 * must stay aligned with the 1× image).
 */

export interface EmulationState {
  dpr: number;
  maxTouchPoints: number;
  /** `(pointer: coarse)`: what touch emulation means to the page's CSS. */
  coarsePointer: boolean;
}

/** Evaluated in the page; a self-contained expression. */
export const EMULATION_PROBE =
  "({ dpr: window.devicePixelRatio, maxTouchPoints: navigator.maxTouchPoints, coarsePointer: window.matchMedia('(pointer: coarse)').matches })";

/** The page's pixel ratio and touch points, or null when the page cannot say. */
export async function readEmulation(page: Pick<Page, 'evaluate'>): Promise<EmulationState | null> {
  try {
    const raw = (await page.evaluate(EMULATION_PROBE)) as Partial<EmulationState> | null;
    if (raw && typeof raw.dpr === 'number' && typeof raw.maxTouchPoints === 'number') {
      return { dpr: raw.dpr, maxTouchPoints: raw.maxTouchPoints, coarsePointer: raw.coarsePointer === true };
    }
  } catch {
    // a page that cannot be evaluated has nothing to restore
  }
  return null;
}

/**
 * Touch emulation lives on the CDP session that set it, and goes when that
 * session detaches, so the session that restores it stays attached for the
 * page's lifetime, one per page.
 */
const touchSessions = new WeakMap<object, CDPSession>();

/**
 * Put back what the capture dropped: the pixel ratio (Playwright re-applies
 * its device metrics, mobile flag included, on setViewportSize) and touch
 * emulation. The page sees two resize events, after a capture that resized
 * it already. Nothing is done when nothing changed, so a profile the capture
 * leaves alone is never touched. Best effort: never fails the capture.
 */
export async function restoreEmulation(page: Page, before: EmulationState | null): Promise<void> {
  if (!before) return;
  const now = await readEmulation(page);
  if (!now) return;
  if (now.dpr === before.dpr && now.maxTouchPoints === before.maxTouchPoints && now.coarsePointer === before.coarsePointer) return;
  try {
    // Touch emulation, whenever the page had touch and its touch points or
    // pointer media changed. What the capture drops depends on Chrome:
    // Chrome 153 drops the touch points and `pointer: coarse`; Chrome 156
    // keeps the touch points and drops `pointer: coarse` and `hover: none`.
    // Sending it again brings back all three; device metrics alone do not.
    if (
      before.maxTouchPoints > 0 &&
      (now.maxTouchPoints !== before.maxTouchPoints || now.coarsePointer !== before.coarsePointer)
    ) {
      let session = touchSessions.get(page);
      if (!session) {
        session = await page.context().newCDPSession(page);
        touchSessions.set(page, session);
      }
      await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: before.maxTouchPoints });
    }
    // The device metrics (pixel ratio, mobile). Playwright does not send a viewport equal to
    // the last one it set, so re-applying the same size does nothing: step
    // 1 px away and back.
    const viewport = page.viewportSize();
    if (viewport) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height + 1 });
      await page.setViewportSize(viewport);
    }
  } catch {
    // the capture is written; a page we cannot restore stays as Chrome left it
  }
}

/**
 * The render probe with the pixel ratio the image was rendered at: the CDP
 * capture renders at 1 whatever the profile says.
 */
export function withCapturedScale(probe: unknown, atCapture: EmulationState | null): unknown {
  if (!atCapture || !probe || typeof probe !== 'object' || Array.isArray(probe)) return probe;
  return { ...(probe as Record<string, unknown>), deviceScaleFactor: atCapture.dpr };
}
