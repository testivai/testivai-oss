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
import {
  appiumEnvironment,
  applyEnvironmentPolicyToName,
  BaselineStore,
  CAPTURE_METHODS,
  DEFAULT_MAX_ELEMENTS,
  installedPackageVersion,
  isNativeAppCapabilities,
  loadLocalConfig,
  mobilePlatform,
  namesBrowser,
  nativeAppDevice,
  nativeAppVariant,
  normalizeElementIdAttributes,
  RENDER_PROBE_EXPRESSION,
  statusBarFromCapabilities,
  statusBarFromViewportRect,
  webDriverEnvironment,
  type CollectedElement,
} from '@testivai/witness';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ADAPTER_VERSION: string = require('../package.json').version;
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

/** A variant as it goes into a snapshot name. */
const variantSegment = (variant: string) => variant.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();

/**
 * Whether this capture is of a native app screen (experimental native mode).
 * Only a mobile session that names no browser is asked for its context, so a
 * browser session makes no extra call. NATIVE_APP is native; a web view
 * (WEBVIEW_…, CHROMIUM) is a page. When the context cannot be read, the
 * capabilities decide: started on an app (app, appPackage, bundleId).
 */
async function isNativeCapture(browser: WitnessBrowser, forced: boolean | undefined): Promise<boolean> {
  if (forced !== undefined) return forced;
  const caps = browser.capabilities;
  if (!mobilePlatform(caps) || namesBrowser(caps)) return false;
  if (typeof browser.getContext === 'function') {
    try {
      const context = await browser.getContext();
      const id = typeof context === 'string' ? context : (context as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && id.length > 0) return id === 'NATIVE_APP';
    } catch {
      // the capabilities decide
    }
  }
  return isNativeAppCapabilities(caps);
}

/**
 * Native mode: a native screen has no page, so no page script runs (Appium
 * rejects them all there, and WebdriverIO resends each failed one three
 * times: ~1.5 s each, measured on an Android 14 emulator). The capture is the
 * screenshot alone, with the status bar masked (its height from
 * `mobile: viewportRect` at capture time, else the capabilities), the
 * environment from the capabilities, and the name keyed by device unless the
 * call gives a variant.
 */
async function witnessNative(browser: WitnessBrowser, name: string, options: WitnessOptions): Promise<void> {
  const localConfig = loadLocalConfig(process.cwd());
  const variant = options.variant ? variantSegment(options.variant) : nativeAppVariant(nativeAppDevice(browser.capabilities));
  if (variant) name = `${name}__${variant}`;

  const environment = appiumEnvironment({
    capabilities: browser.capabilities,
    adapter: { name: '@testivai/witness-webdriverio', version: ADAPTER_VERSION, captureMethod: CAPTURE_METHODS.APPIUM_SCREEN },
    framework: { name: 'webdriverio', version: installedPackageVersion('webdriverio') },
  });
  name = applyEnvironmentPolicyToName(
    name,
    { browser: { name: environment.browser.name }, os: { platform: process.platform } },
    localConfig.environmentPolicy,
  );

  let statusBar: number | null = null;
  if (options.maskStatusBar !== false) {
    try {
      statusBar = statusBarFromViewportRect(await browser.execute<unknown>('mobile: viewportRect'));
    } catch {
      // older drivers: the capabilities' reading from the session start
    }
    statusBar ??= statusBarFromCapabilities(browser.capabilities);
  }

  const base64 = await browser.takeScreenshot();
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new Error(`testivai.witness("${name}"): browser.takeScreenshot() returned an empty value`);
  }

  const store = new BaselineStore(process.cwd());
  // Nothing from an earlier capture of this name: no DOM, element map or metadata.
  for (const leftover of [store.getTempDomPath(name), store.getTempMetadataPath(name), path.join(store.getTempDir(), name, 'elements.json')]) {
    fs.rmSync(leftover, { force: true });
  }
  store.writeTemp(name, Buffer.from(base64, 'base64'));
  store.writeTempMetadata(name, { name, environment, ...(statusBar ? { masks: [{ top: statusBar }] } : {}) });
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

  if (options.context !== undefined) {
    return inContext(browser, options.context, (native) => capture(browser, name, { ...options, native: options.native ?? native }));
  }
  return capture(browser, name, options);
}

/** A context as Appium names it: a string, or WebdriverIO's detailed `{ id }`. */
const contextName = (c: unknown): string =>
  typeof c === 'string' ? c : typeof (c as { id?: unknown } | null)?.id === 'string' ? (c as { id: string }).id : '';

/**
 * Run a capture in another Appium context and switch back afterwards, also
 * when it fails. `'webview'` is the web view named after the app (Android
 * names it WEBVIEW_<package>), else the first one (iOS numbers them).
 * Native mode follows the context: NATIVE_APP is native, any other is a page.
 */
async function inContext(
  browser: WitnessBrowser,
  wanted: string,
  run: (native: boolean) => Promise<void>,
): Promise<void> {
  if (typeof browser.getContext !== 'function' || typeof browser.getContexts !== 'function' || typeof browser.switchContext !== 'function') {
    throw new Error('testivai.witness: options.context needs an Appium session: browser.getContext(), getContexts() and switchContext()');
  }
  const contexts = (await browser.getContexts()).map(contextName).filter((c) => c.length > 0);
  const current = contextName(await browser.getContext());

  let target: string | undefined;
  if (wanted === 'webview') {
    const views = contexts.filter((c) => c.startsWith('WEBVIEW'));
    const caps = (browser.capabilities ?? {}) as Record<string, unknown>;
    const app = caps.appPackage ?? caps['appium:appPackage'] ?? caps.bundleId ?? caps['appium:bundleId'];
    target = views.find((c) => typeof app === 'string' && c === `WEBVIEW_${app}`) ?? views[0];
    if (!target) {
      throw new Error(
        `testivai.witness: options.context 'webview': no web view context in this session (contexts: ${contexts.join(', ') || 'none'}). ` +
          "The app's build needs WebView debugging enabled (Android WebView.setWebContentsDebuggingEnabled, iOS isInspectable), and the web view must be on screen.",
      );
    }
  } else {
    target = wanted;
    if (!contexts.includes(target)) {
      throw new Error(`testivai.witness: options.context: no context "${wanted}" in this session (contexts: ${contexts.join(', ') || 'none'})`);
    }
  }

  const switched = target !== current && current.length > 0;
  if (target !== current) await browser.switchContext(target);
  try {
    await run(target === 'NATIVE_APP');
  } catch (err) {
    // Back where the test was; the capture error is the one that matters.
    if (switched) await browser.switchContext(current).catch(() => undefined);
    throw err;
  }
  // A failed switch back leaves the session elsewhere: let it surface.
  if (switched) await browser.switchContext(current);
}

/** One capture in the session's current context: native mode or a page. */
async function capture(browser: WitnessBrowser, name: string, options: WitnessOptions): Promise<void> {
  if (await isNativeCapture(browser, options.native)) {
    return witnessNative(browser, name, options);
  }

  // Multi-capability runs: fold the variant into the name so capabilities
  // don't overwrite each other's baselines (same mechanism as the Playwright
  // adapter's multi-project handling).
  if (options.variant) {
    name = `${name}__${variantSegment(options.variant)}`;
  }

  const localConfig = loadLocalConfig(process.cwd());

  // Capture provenance: what the page is rendered with, measured before
  // anything is injected, plus the session's capabilities. Best-effort.
  let renderProbe: unknown = null;
  if (typeof browser.execute === 'function') {
    try {
      renderProbe = await browser.execute<unknown>(`return ${RENDER_PROBE_EXPRESSION}`);
    } catch {
      // no probe: no render settings recorded
    }
  }
  const environment = webDriverEnvironment({
    capabilities: browser.capabilities,
    probe: renderProbe,
    adapter: { name: '@testivai/witness-webdriverio', version: ADAPTER_VERSION, captureMethod: CAPTURE_METHODS.WEBDRIVER_VIEWPORT },
    framework: { name: 'webdriverio', version: installedPackageVersion('webdriverio') },
  });
  name = applyEnvironmentPolicyToName(
    name,
    { browser: { name: environment?.browser.name ?? 'unknown' }, os: { platform: process.platform } },
    localConfig.environmentPolicy,
  );

  // 0. Prepare the page: stabilization CSS (animations/caret/fonts — the
  //    flake killers) + ignoreSelectors from config.json and this call,
  //    injected as one style tag and removed after the capture.
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
  // Opt-in: paths anchored on attributes such as data-testid (config
  // `elementIdAttributes`), recorded with the capture only when set.
  const idAttributes = normalizeElementIdAttributes(localConfig.elementIdAttributes);
  let elementMap: CollectedElement[] | undefined;
  if (!options.skipElementMap && typeof browser.execute === 'function') {
    try {
      const result = await browser.execute<unknown>(
        elementMapScript(options.maxElements ?? DEFAULT_MAX_ELEMENTS, ignoreSelectors, idAttributes),
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
  if (environment) {
    try {
      store.writeTempMetadata(name, { name, environment });
    } catch {
      // without it the compare cannot tell rendering drift from noise for this capture
    }
  }
  if (elementMap) {
    try {
      const tempDir = path.join(process.cwd(), '.testivai', 'temp', name);
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'elements.json'), JSON.stringify(elementMap));
      if (idAttributes.length > 0) store.writeTempMetadata(name, { elementIdAttributes: idAttributes });
    } catch {
      // A map we cannot persist is not worth failing a capture over.
    }
  }
}
