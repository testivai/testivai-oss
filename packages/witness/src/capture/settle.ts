/**
 * Page-settled probe — "has this page stopped changing?" answered without
 * screenshotting repeatedly.
 *
 * WHY NOT NETWORK IDLE
 * --------------------
 * Playwright's own docs mark `networkidle` **DISCOURAGED**: "Don't use this
 * method for testing, rely on web assertions to assess readiness instead." It
 * is the wrong signal for a visual snapshot anyway — a page with analytics
 * beacons or long-polling never goes quiet yet is perfectly settled, while a
 * page can be network-idle with a CSS animation still running.
 *
 * WHY NOT A SETTLE LOOP
 * ---------------------
 * Playwright's built-in screenshots repeatedly until two consecutive images
 * match. That costs a capture per attempt. TestivAI already labels render
 * jitter through the DOM/style layer (identical DOM + identical computed styles
 * is labeled likely render noise; the diff is still reported, and auto-passes
 * only when a pass criterion is configured: noiseAutoPass, a
 * maxDiffPercent / maxDiffPixels tolerance, or shiftTolerance when every
 * region is a verified small shift), so the only gap left is
 * content that had not *loaded* yet — which is a load question, not a pixel
 * question.
 *
 * One pixel question remains, and it is Chrome's, not the page's: a
 * beyond-viewport capture can return a frame painted for the wrong viewport
 * while the measured page is unchanged. That is guarded at capture time in
 * capture/stable-capture.ts (fresh frame, then capture until two in a row
 * match), which costs one extra screenshot on a stable page. This probe still
 * decides when to start capturing.
 *
 * WHAT THIS DOES
 * --------------
 * A cheap synchronous probe the adapter polls from the host language, exactly
 * like the existing fonts wait. It reports whether the document is complete,
 * whether images have finished, and how long the DOM has been quiet — the last
 * measured with a MutationObserver, which observes rather than monkey-patching
 * `fetch`/`XHR` and so cannot alter the behaviour of the page under test.
 *
 * SELF-CONTAINED on purpose: no imports, no closures, so it can be serialised
 * into the page and shipped to the Python, Java and Ruby adapters as a
 * generated asset — the same approach as the element-map collector.
 */

export interface SettleState {
  /** document.readyState === 'complete' */
  ready: boolean;
  /** Images still decoding. `complete` is true for failed loads, so a 404 never hangs us. */
  imagesPending: number;
  /** Web fonts still loading, when the Font Loading API is available. */
  fontsPending: boolean;
  /** Milliseconds since the last DOM mutation. */
  quietFor: number;
  /** Everything above satisfied, including the quiet threshold. */
  settled: boolean;
}

/** Global key holding the observer state between polls. */
export const SETTLE_STATE_KEY = '__testivaiSettleState';

/**
 * One poll. Installs the MutationObserver on first call and reuses it after,
 * so repeated polls are cheap.
 */
export function settleProbe(
  doc: {
    readyState: string;
    documentElement: unknown;
    images: ArrayLike<{ complete: boolean }>;
    fonts?: { status?: string };
  },
  win: Record<string, unknown> & { MutationObserver?: new (cb: () => void) => { observe: (t: unknown, o: unknown) => void } },
  quietMs: number,
): SettleState {
  var KEY = '__testivaiSettleState';
  var state = win[KEY] as { last: number } | undefined;

  if (!state) {
    state = { last: Date.now() };
    try {
      if (typeof win.MutationObserver === 'function') {
        var observer = new win.MutationObserver(function () {
          (win[KEY] as { last: number }).last = Date.now();
        });
        observer.observe(doc.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        (state as { observer?: unknown }).observer = observer;
      }
    } catch (e) {
      // No MutationObserver (or a hostile document): quietness degrades to
      // "always quiet" rather than blocking the capture.
    }
    win[KEY] = state;
  }

  var imagesPending = 0;
  try {
    for (var i = 0; i < doc.images.length; i++) {
      if (!doc.images[i].complete) imagesPending++;
    }
  } catch (e) {
    imagesPending = 0;
  }

  var fontsPending = false;
  try {
    fontsPending = !!(doc.fonts && doc.fonts.status && doc.fonts.status !== 'loaded');
  } catch (e) {
    fontsPending = false;
  }

  var ready = doc.readyState === 'complete';
  var quietFor = Date.now() - state.last;

  return {
    ready: ready,
    imagesPending: imagesPending,
    fontsPending: fontsPending,
    quietFor: quietFor,
    settled: ready && imagesPending === 0 && !fontsPending && quietFor >= quietMs,
  };
}

/** Default DOM-quiet threshold. Long enough to span a render, short enough not to be felt. */
export const DEFAULT_QUIET_MS = 150;

/** Default ceiling on waiting. A page that never settles must not hang the suite. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 5000;

/** The expression an adapter evaluates for one poll. */
export function buildSettleProbeExpression(quietMs: number = DEFAULT_QUIET_MS): string {
  return `(${settleProbe.toString()})(document, window, ${quietMs})`;
}

/**
 * Disconnect the observer and drop the global. Adapters call this in the same
 * `finally` that removes the injected CSS — leaving an observer attached to
 * someone else's page would be rude and would keep firing for the rest of the
 * test.
 */
export const SETTLE_STOP_EXPRESSION = `(function (w) {
  try {
    var s = w['${SETTLE_STATE_KEY}'];
    if (s && s.observer && typeof s.observer.disconnect === 'function') s.observer.disconnect();
  } catch (e) {}
  try { delete w['${SETTLE_STATE_KEY}']; } catch (e) { w['${SETTLE_STATE_KEY}'] = undefined; }
})(window)`;
