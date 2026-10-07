/**
 * @testivai/witness-webdriverio — capture function
 *
 * The user-facing call inside a WebdriverIO test:
 *
 *   import { testivai } from '@testivai/witness-webdriverio';
 *   await testivai.witness(browser, 'homepage');
 *
 * Captures the viewport screenshot via `browser.takeScreenshot()` (WebDriver's
 * Take Screenshot is viewport-sized), the page DOM, and the element map via
 * `browser.execute(...)`, then writes them into `.testivai/temp/<name>/` using the same
 * BaselineStore layout as @testivai/witness-playwright. The TestivaiService
 * (registered in wdio.conf.ts) runs `compareAll` + `generateReport` after
 * all tests finish.
 *
 * Architectural choice: we rely on WebdriverIO's native `takeScreenshot`
 * and `execute` APIs rather than opening a CDP session. This is the whole
 * point of the per-framework adapter — using the framework's stable public
 * API instead of fighting Chrome-launch coordination.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaselineStore, DEFAULT_MAX_ELEMENTS, loadLocalConfig, type CollectedElement } from '@testivai/witness';
import { elementMapScript, isPageElementMap, toViewportElementMap } from './element-map';
import type { WitnessBrowser, WitnessOptions } from './types';

/** id of the style element injected for the duration of a capture */
const STYLE_ID = '__testivai_capture_css__';

/**
 * Freezes CSS animations/transitions, hides the caret, and forces instant
 * scrolling — the top causes of flaky visual diffs. Mirrors the Playwright
 * adapter's STABILIZE_CSS.
 */
const STABILIZE_CSS =
  '*, *::before, *::after { animation-duration: 0.001s !important; animation-delay: 0s !important; ' +
  'animation-iteration-count: 1 !important; transition-duration: 0.001s !important; ' +
  'transition-delay: 0s !important; caret-color: transparent !important; scroll-behavior: auto !important; }';

/** Build the ignoreSelectors CSS block (visibility preserves layout). */
function buildIgnoreCss(selectors: string[]): string {
  return selectors.map((s) => `${s} { visibility: hidden !important; }`).join('\n');
}

/**
 * Inject a <style> tag with the given CSS. Returns true when injection
 * succeeded. Uses the inline-string form of execute for WDIO 8/9 parity.
 */
async function injectCaptureCss(browser: WitnessBrowser, css: string): Promise<boolean> {
  try {
    await browser.execute(
      `var el = document.createElement('style');` +
        `el.id = ${JSON.stringify(STYLE_ID)};` +
        `el.textContent = ${JSON.stringify(css)};` +
        `document.head.appendChild(el);`,
    );
    return true;
  } catch {
    return false; // capture proceeds without stabilization/ignores
  }
}

async function removeCaptureCss(browser: WitnessBrowser): Promise<void> {
  try {
    await browser.execute(
      `var el = document.getElementById(${JSON.stringify(STYLE_ID)});` +
        `if (el) el.remove();`,
    );
  } catch {
    // best-effort cleanup
  }
}

/**
 * Wait (bounded at ~3s) for web fonts to finish loading so the capture never
 * shows a fallback font. Polled from Node because classic WebDriver execute
 * does not await page-side promises.
 */
async function waitForFonts(browser: WitnessBrowser): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      const status = await browser.execute<string>(
        `return document.fonts ? document.fonts.status : 'loaded';`,
      );
      if (status !== 'loading' || Date.now() >= deadline) return;
    } catch {
      return; // no FontFaceSet or execute failed — proceed
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Capture a screenshot + DOM and write them as a temp snapshot.
 *
 * @param browser WebdriverIO browser-like object (must expose
 *   `takeScreenshot()` and `execute()`).
 * @param name    Snapshot name. Becomes the directory under
 *   `.testivai/temp/<name>/` and the key in the rendered report.
 * @param options Per-call overrides.
 */
export async function witness(
  browser: WitnessBrowser,
  name: string,
  options: WitnessOptions = {},
): Promise<void> {
  if (!name || typeof name !== 'string') {
    throw new Error('testivai.witness: snapshot name is required and must be a non-empty string');
  }
  if (!browser || typeof browser.takeScreenshot !== 'function') {
    throw new Error('testivai.witness: browser argument must expose takeScreenshot()');
  }

  // Multi-capability runs: fold the variant into the name so capabilities
  // don't overwrite each other's baselines (same mechanism as the Playwright
  // adapter's multi-project handling).
  if (options.variant) {
    name = `${name}__${options.variant.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase()}`;
  }

  // 0. Prepare the page: stabilization CSS (animations/caret/fonts — the
  //    flake killers) + ignoreSelectors from config.json and this call,
  //    injected as one style tag and removed after the capture.
  const localConfig = loadLocalConfig(process.cwd());
  const stabilize = options.stabilize ?? localConfig.stabilize;
  const ignoreSelectors = [
    ...new Set([...(localConfig.ignoreSelectors ?? []), ...(options.ignoreSelectors ?? [])]),
  ];

  const cssParts: string[] = [];
  if (stabilize) cssParts.push(STABILIZE_CSS);
  if (ignoreSelectors.length > 0) cssParts.push(buildIgnoreCss(ignoreSelectors));

  let injected = false;
  if (cssParts.length > 0 && typeof browser.execute === 'function') {
    injected = await injectCaptureCss(browser, cssParts.join('\n'));
    if (stabilize) await waitForFonts(browser);
  }

  // 1. Capture screenshot (base64 PNG → Buffer)
  let base64: string;
  try {
    base64 = await browser.takeScreenshot();
  } finally {
    if (injected) await removeCaptureCss(browser);
  }
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new Error(`testivai.witness("${name}"): browser.takeScreenshot() returned an empty value`);
  }
  const screenshot = Buffer.from(base64, 'base64');

  // 2. Capture DOM (best-effort — never break the screenshot path)
  let dom: string | undefined;
  if (!options.skipDom && typeof browser.execute === 'function') {
    try {
      const result = await browser.execute<string>(
        // Inline string form for maximum WDIO sync/async compatibility.
        // ignoreSelectors excludes elements from the pixel diff, so they
        // are excluded from the DOM/text signal too (consistent semantic).
        `var clone = document.documentElement.cloneNode(true);` +
          `var sels = ${JSON.stringify(ignoreSelectors)};` +
          `for (var i = 0; i < sels.length; i++) {` +
          ` try { clone.querySelectorAll(sels[i]).forEach(function(el){ el.remove(); }); } catch (e) {}` +
          `}` +
          `return clone.outerHTML;`,
      );
      if (typeof result === 'string' && result.length > 0) {
        dom = result;
      }
    } catch {
      // Suppressed by design. DOM capture failure means the noise hint
      // is unavailable for this snapshot; pixel diff still works.
    }
  }

  // 3. Capture the element map (best-effort — same contract as the DOM).
  //    It powers the style check, region attribution and page-shift
  //    detection on the compare side. The screenshot is the viewport, so the
  //    map keeps only the elements inside it, in screenshot coordinates.
  let elementMap: CollectedElement[] | undefined;
  if (!options.skipElementMap && typeof browser.execute === 'function') {
    try {
      const result = await browser.execute<unknown>(
        elementMapScript(options.maxElements ?? DEFAULT_MAX_ELEMENTS, ignoreSelectors),
      );
      if (isPageElementMap(result)) {
        const inView = toViewportElementMap(result);
        if (inView.length > 0) elementMap = inView;
      }
    } catch {
      // Suppressed by design, exactly like DOM capture: without a map the
      // report falls back to the pixel and DOM layers instead of failing.
    }
  }

  // 4. Write to .testivai/temp/<name>/
  const store = new BaselineStore(process.cwd());
  store.writeTemp(name, screenshot, dom);
  if (elementMap) {
    try {
      const tempDir = path.join(process.cwd(), '.testivai', 'temp', name);
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'elements.json'), JSON.stringify(elementMap));
    } catch {
      // A map we cannot persist is not worth failing a capture over.
    }
  }
}
