/**
 * Public types for @testivai/witness-selenium.
 */

/**
 * Minimal subset of the selenium-webdriver `WebDriver` the witness function
 * relies on. Structural typing means consumers can pass any Selenium-shaped
 * object (real driver or mock) without us pulling `selenium-webdriver`'s
 * types into our public surface.
 */
export interface WitnessDriver {
  /**
   * Capture a screenshot of the current viewport. Returns a base64 PNG,
   * matching selenium-webdriver's `driver.takeScreenshot()` return shape.
   * Used as the fallback when no full-page mechanism is available.
   */
  takeScreenshot(): Promise<string>;

  /**
   * Execute a script in the page context. We only use the string form with
   * trailing args (`arguments[0]`… inside the script).
   */
  executeScript<T = unknown>(script: string, ...args: unknown[]): Promise<T>;

  /**
   * Chromium-only (chrome.Driver / edge.Driver): raw CDP command. Presence
   * of this method is how the adapter detects that full-page capture via
   * `Page.captureScreenshot` (captureBeyondViewport) is available — the
   * same mechanism Playwright uses under the hood. Absent on Firefox and
   * Safari drivers, which fall back to the viewport screenshot.
   */
  sendAndGetDevToolsCommand?<T = unknown>(cmd: string, params?: object): Promise<T>;

  /**
   * selenium-webdriver's `driver.getCapabilities()`. Optional: when present,
   * the browser, its version and the driver are recorded as capture
   * provenance in the capture's metadata.json.
   */
  getCapabilities?(): Promise<unknown>;
}

/**
 * Options for a single witness() call. All optional.
 */
export interface WitnessOptions {
  /**
   * Skip DOM capture even if the adapter would normally write dom.html
   * alongside the screenshot. Use for pages where DOM serialization is
   * known to be expensive or unstable.
   */
  skipDom?: boolean;
  /**
   * Skip element-map capture. The map powers region→selector attribution,
   * shift classification, and the computed-style fingerprint; skipping it
   * leaves the pixel and DOM layers intact.
   */
  skipElementMap?: boolean;
  /**
   * Milliseconds the DOM must be free of mutations before capturing
   * (default 150). Raise it for pages that stream content in.
   */
  settleQuietMs?: number;
  /** Ceiling on waiting for the page to settle (default 5000ms). */
  settleTimeoutMs?: number;
  /**
   * Cap on elements walked for the map (default 3000). Lower it on very
   * large pages where the single executeScript round trip is costly.
   */
  maxElements?: number;
  /**
   * CSS selectors for elements to hide (`visibility: hidden`) for the
   * duration of the capture, so dynamic content (timestamps, ads, live
   * widgets) never contributes to the pixel diff. Merged with the global
   * `ignoreSelectors` list from `.testivai/config.json`. Matched elements
   * are also excluded from the DOM snapshot (one consistent semantic).
   */
  ignoreSelectors?: string[];
  /**
   * Variant key for multi-browser / multi-viewport runs. Folded into the
   * snapshot name (`<name>__<variant>`) so parallel sessions don't
   * overwrite each other's baselines. Example: `'firefox'`, `'chrome-1280'`.
   */
  variant?: string;
  /**
   * Stabilize the page before capture: disable CSS animations/transitions,
   * hide the caret, and wait for web fonts. Overrides the `stabilize`
   * setting from `.testivai/config.json` (default true).
   */
  stabilize?: boolean;
}
