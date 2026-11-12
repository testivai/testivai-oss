/**
 * @testivai/witness-selenium — capture function
 *
 * The user-facing call inside a Selenium (JavaScript) test:
 *
 *   import { testivai } from '@testivai/witness-selenium';
 *   await testivai.witness(driver, 'homepage');
 *
 * Captures a screenshot and the page DOM through Selenium's public APIs,
 * then writes both into `.testivai/temp/<name>/` using the same
 * BaselineStore layout as every other TestivAI adapter. Run
 * `npx testivai report` after the tests to compare against baselines.
 *
 * Full-page screenshots per browser:
 *   - Chromium (Chrome/Edge): CDP `Page.captureScreenshot` with
 *     captureBeyondViewport via `sendAndGetDevToolsCommand` — the same
 *     mechanism Playwright uses under the hood
 *   - Firefox/Safari: the JS bindings expose no full-page API, so the
 *     capture is viewport-only (keep the window sized to what you want
 *     compared; baselines are consistent run-to-run either way)
 */

import {
  BaselineStore,
  loadLocalConfig,
  buildElementMapExpression,
  normalizeElementIdAttributes,
  DEFAULT_MAX_ELEMENTS,
  parseShardEnv,
  writeShardManifest,
  buildSettleProbeExpression,
  SETTLE_STOP_EXPRESSION,
  DEFAULT_QUIET_MS,
  DEFAULT_SETTLE_TIMEOUT_MS,
  applyEnvironmentPolicyToName,
  browserFromCapabilities,
  browserFromUserAgent,
  CAPTURE_METHODS,
  installedPackageVersion,
  parseRenderProbe,
  RENDER_PROBE_EXPRESSION,
  webDriverEnvironment,
  type CaptureHealth,
  type LocalConfig,
} from '@testivai/witness';
import * as fs from 'fs';
import * as path from 'path';
import { captureFullPageScreenshot, type CdpDriver } from './capture/full-page';
import { probeCaptureHealth, recordCaptureHealth } from './capture/health';
import type { WitnessDriver, WitnessOptions } from './types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ADAPTER_VERSION: string = require('../package.json').version;

/** id of the style element injected for the duration of a capture */
const STYLE_ID = '__testivai_capture_css__';

/**
 * Freezes CSS animations/transitions, hides the caret, and forces instant
 * scrolling — the top causes of flaky visual diffs. Near-zero durations
 * (not `none`) let entry animations COMPLETE at their final state.
 * Mirrors the Playwright adapter's STABILIZE_CSS.
 */
const STABILIZE_CSS =
  '*, *::before, *::after { animation-duration: 0.001s !important; animation-delay: 0s !important; ' +
  'animation-iteration-count: 1 !important; transition-duration: 0.001s !important; ' +
  'transition-delay: 0s !important; caret-color: transparent !important; scroll-behavior: auto !important; }';

/** Build the ignoreSelectors CSS block (visibility preserves layout). */
function buildIgnoreCss(selectors: string[]): string {
  return selectors.map((s) => `${s} { visibility: hidden !important; }`).join('\n');
}

async function injectCaptureCss(driver: WitnessDriver, css: string): Promise<boolean> {
  try {
    await driver.executeScript(
      `var el = document.createElement('style');` +
        `el.id = arguments[0]; el.textContent = arguments[1];` +
        `document.head.appendChild(el);`,
      STYLE_ID,
      css,
    );
    return true;
  } catch {
    return false; // locked-down page; capture proceeds without stabilization
  }
}

async function removeCaptureCss(driver: WitnessDriver): Promise<void> {
  try {
    await driver.executeScript(
      `var el = document.getElementById(arguments[0]); if (el) el.remove();`,
      STYLE_ID,
    );
  } catch {
    // best-effort cleanup
  }
}

/**
 * Wait (bounded at 10s) for web fonts to finish loading so the capture
 * never shows a fallback font — a fallback-font capture diffs 30%+.
 */
/**
 * Wait until the page has stopped changing: document complete, images finished,
 * fonts loaded, and no DOM mutations for `quietMs`.
 *
 * Deliberately NOT network idle — Playwright's own docs mark that DISCOURAGED
 * for testing, and it is the wrong signal anyway: a page with analytics beacons
 * never goes quiet, while a network-idle page can still be animating.
 *
 * Always bounded. A page that never settles yields a capture with a debug note
 * rather than a hung suite.
 */
async function waitForSettled(
  driver: WitnessDriver,
  quietMs: number,
  timeoutMs: number,
): Promise<void> {
  const expr = buildSettleProbeExpression(quietMs);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const state = await driver.executeScript<{ settled?: boolean }>(`return ${expr}`);
      // A driver that cannot evaluate the probe returns nothing. Polling that
      // to the timeout would add the full wait to EVERY capture, so treat an
      // unusable answer as "cannot probe" and proceed immediately.
      if (!state || typeof state.settled !== 'boolean') return;
      if (state.settled) return;
      if (Date.now() >= deadline) return;
    } catch {
      return; // probe unavailable — never block the capture
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stopSettleObserver(driver: WitnessDriver): Promise<void> {
  try {
    await driver.executeScript(SETTLE_STOP_EXPRESSION);
  } catch {
    // best-effort cleanup
  }
}

async function waitForFonts(driver: WitnessDriver): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const ready = await driver.executeScript<boolean>(
        `return document.fonts ? document.fonts.status !== 'loading' : true;`,
      );
      if (ready || Date.now() >= deadline) return;
    } catch {
      return; // no FontFaceSet or executeScript failed — proceed
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Full-page screenshot where the driver supports it, viewport otherwise.
 * Returns the PNG and the capture method it came from.
 */
async function captureScreenshot(driver: WitnessDriver): Promise<{ png: Buffer; method: string }> {
  // Chromium drivers expose raw CDP; captureBeyondViewport gives a true
  // full-page capture without resizing the window (which breaks 100vh
  // layouts — the reason we never use the resize trick). It waits for a
  // fresh frame and captures until two in a row match: Chrome can return a
  // frame painted for the wrong viewport while it sets up the capture
  // (capture/full-page.ts).
  if (typeof driver.sendAndGetDevToolsCommand === 'function') {
    const captureLog =
      process.env.TESTIVAI_DEBUG === 'true'
        ? (message: string) => console.log(`[TestivAI] Full-page capture: ${message}`)
        : undefined;
    try {
      const png = await captureFullPageScreenshot(driver as CdpDriver, captureLog);
      return { png, method: CAPTURE_METHODS.CDP_FULL_PAGE };
    } catch {
      // fall through to the viewport screenshot
    }
  }

  const base64 = await driver.takeScreenshot();
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new Error('testivai.witness: driver.takeScreenshot() returned an empty value');
  }
  return { png: Buffer.from(base64, 'base64'), method: CAPTURE_METHODS.WEBDRIVER_VIEWPORT };
}

/** Everything a capture reads from config and the call before touching the page. */
interface CapturePlan {
  stabilize: boolean;
  ignoreSelectors: string[];
  /** The one style tag injected for the capture: stabilization, then the ignores. */
  css: string;
  idAttributes: string[];
}

/** What the session says about itself, read before anything is injected. */
interface Session {
  renderProbe: unknown;
  capabilities: unknown;
}

function assertArguments(driver: WitnessDriver, name: string): void {
  if (!name || typeof name !== 'string') {
    throw new Error('testivai.witness: snapshot name is required and must be a non-empty string');
  }
  if (!driver || typeof driver.takeScreenshot !== 'function') {
    throw new Error('testivai.witness: driver argument must expose takeScreenshot()');
  }
}

/**
 * Capture provenance: what the page is rendered with, measured before
 * anything is injected, plus the session's capabilities. Best-effort.
 */
async function readSession(driver: WitnessDriver): Promise<Session> {
  const session: Session = { renderProbe: null, capabilities: null };
  if (typeof driver.executeScript === 'function') {
    try {
      session.renderProbe = await driver.executeScript<unknown>(`return ${RENDER_PROBE_EXPRESSION}`);
    } catch {
      // no probe: no render settings recorded
    }
  }
  if (typeof driver.getCapabilities === 'function') {
    try {
      session.capabilities = await driver.getCapabilities();
    } catch {
      // no capabilities: the probe's user agent is the fallback
    }
  }
  return session;
}

/** The engine, from the capabilities, else the user agent, else 'unknown'. */
function browserNameOf(session: Session): string {
  const fromCapabilities = browserFromCapabilities(session.capabilities)?.browser.name;
  if (fromCapabilities !== undefined) return fromCapabilities;
  const ua = parseRenderProbe(session.renderProbe)?.userAgent;
  return (ua ? browserFromUserAgent(ua)?.name : undefined) ?? 'unknown';
}

/**
 * The snapshot's key. Multi-browser runs: the variant folds into the name so
 * sessions don't overwrite each other's baselines (same mechanism as the
 * Playwright adapter's multi-project handling); then environmentPolicy
 * "separate" adds the browser and platform.
 */
function snapshotKey(name: string, options: WitnessOptions, session: Session, localConfig: LocalConfig): string {
  if (options.variant) {
    name = `${name}__${options.variant.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase()}`;
  }
  return applyEnvironmentPolicyToName(name, { browser: { name: browserNameOf(session) }, os: { platform: process.platform } }, localConfig.environmentPolicy);
}

/**
 * Stabilization CSS (animations/caret/fonts — the flake killers) +
 * ignoreSelectors from config.json and this call, injected as one style tag
 * and removed after the capture.
 */
function capturePlan(options: WitnessOptions, localConfig: LocalConfig): CapturePlan {
  const stabilize = options.stabilize ?? localConfig.stabilize;
  const ignoreSelectors = [
    ...new Set([...(localConfig.ignoreSelectors ?? []), ...(options.ignoreSelectors ?? [])]),
  ];
  const cssParts: string[] = [];
  if (stabilize) cssParts.push(STABILIZE_CSS);
  if (ignoreSelectors.length > 0) cssParts.push(buildIgnoreCss(ignoreSelectors));
  return { stabilize, ignoreSelectors, css: cssParts.join('\n'), idAttributes: normalizeElementIdAttributes(localConfig.elementIdAttributes) };
}

/** Inject the capture style and wait for the page; true when the style went in. */
async function prepare(driver: WitnessDriver, plan: CapturePlan, options: WitnessOptions): Promise<boolean> {
  if (plan.css.length === 0 || typeof driver.executeScript !== 'function') return false;
  const injected = await injectCaptureCss(driver, plan.css);
  if (plan.stabilize) {
    await waitForFonts(driver);
    await waitForSettled(
      driver,
      options.settleQuietMs ?? DEFAULT_QUIET_MS,
      options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
    );
  }
  return injected;
}

/**
 * Prepare the page, take the screenshot (full-page on Chromium, viewport
 * elsewhere), read what failed to load, put the page back. Capture health is
 * read right after the screenshot and before the style comes off: removing a
 * style that hid an element can start loading a web font only it uses.
 */
async function shoot(
  driver: WitnessDriver,
  plan: CapturePlan,
  options: WitnessOptions,
): Promise<{ png: Buffer; method: string; health: CaptureHealth | null }> {
  const injected = await prepare(driver, plan, options);
  try {
    const shot = await captureScreenshot(driver);
    const health = typeof driver.executeScript === 'function' ? await probeCaptureHealth((script) => driver.executeScript(script)) : null;
    return { ...shot, health };
  } finally {
    if (injected) await removeCaptureCss(driver);
    if (plan.stabilize) await stopSettleObserver(driver);
  }
}

/** The DOM, best-effort: a failure only means no noise hint for this snapshot. */
async function readDom(driver: WitnessDriver, options: WitnessOptions, ignoreSelectors: string[]): Promise<string | undefined> {
  if (options.skipDom || typeof driver.executeScript !== 'function') return undefined;
  try {
    const result = await driver.executeScript<string>(
      // ignoreSelectors excludes elements from the pixel diff, so they
      // are excluded from the DOM/text signal too (consistent semantic).
      `var clone = document.documentElement.cloneNode(true);` +
        `var sels = arguments[0] || [];` +
        `for (var i = 0; i < sels.length; i++) {` +
        ` try { clone.querySelectorAll(sels[i]).forEach(function(el){ el.remove(); }); } catch (e) {}` +
        `}` +
        `return clone.outerHTML;`,
      ignoreSelectors,
    );
    return typeof result === 'string' && result.length > 0 ? result : undefined;
  } catch {
    // Suppressed by design. DOM capture failure means the noise hint
    // is unavailable for this snapshot; pixel diff still works.
    return undefined;
  }
}

/**
 * The element map (best-effort — same contract as the DOM). This is what
 * powers region→selector attribution, shift classification, and the
 * computed-style fingerprint on the compare side. The injected function is
 * the SAME one the Playwright adapter uses (`@testivai/witness`), so both
 * lanes produce identical maps. Selenium's executeScript needs an explicit
 * `return`. Paths are anchored on `elementIdAttributes` when config sets them.
 */
async function readElementMap(driver: WitnessDriver, options: WitnessOptions, plan: CapturePlan): Promise<unknown> {
  if (options.skipElementMap || typeof driver.executeScript !== 'function') return undefined;
  try {
    const expr = buildElementMapExpression(options.maxElements ?? DEFAULT_MAX_ELEMENTS, plan.ignoreSelectors, plan.idAttributes);
    const result = await driver.executeScript<unknown>(`return ${expr}`);
    return Array.isArray(result) && result.length > 0 ? result : undefined;
  } catch {
    // Suppressed by design, exactly like DOM capture: without a map the
    // report falls back to pixel + DOM layers instead of failing.
    return undefined;
  }
}

/** Capture provenance into metadata.json; nothing when no browser can be named. */
function recordEnvironment(store: BaselineStore, name: string, session: Session, captureMethod: string): void {
  const environment = webDriverEnvironment({
    capabilities: session.capabilities,
    probe: session.renderProbe,
    adapter: { name: '@testivai/witness-selenium', version: ADAPTER_VERSION, captureMethod },
    framework: { name: 'selenium-webdriver', version: installedPackageVersion('selenium-webdriver') },
  });
  if (!environment) return;
  try {
    store.writeTempMetadata(name, { name, environment });
  } catch {
    // without it the compare cannot tell rendering drift from noise for this capture
  }
}

/**
 * Shard manifest. A Selenium script has no end-of-run hook to attach to, so
 * it is refreshed on every capture — which is exactly what lets a Selenium
 * suite join the same sharded CI flow as Playwright. `complete` stays false
 * because this adapter cannot know the run finished.
 */
function refreshShardManifest(): void {
  const shard = parseShardEnv(process.env.TESTIVAI_SHARD);
  if (shard) writeShardManifest(path.join(process.cwd(), '.testivai', 'temp'), shard);
}

function writeElementMap(store: BaselineStore, name: string, elementMap: unknown, idAttributes: string[]): void {
  if (elementMap === undefined) return;
  const tempDir = path.join(process.cwd(), '.testivai', 'temp', name);
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'elements.json'), JSON.stringify(elementMap));
    if (idAttributes.length > 0) store.writeTempMetadata(name, { elementIdAttributes: idAttributes });
  } catch {
    // A map we cannot persist is not worth failing a capture over.
  }
}

/**
 * Capture a screenshot + DOM and write them as a temp snapshot.
 *
 * @param driver  selenium-webdriver WebDriver (must expose
 *   `takeScreenshot()` and `executeScript()`).
 * @param name    Snapshot name. Becomes the directory under
 *   `.testivai/temp/<name>/` and the key in the rendered report.
 * @param options Per-call overrides.
 */
export async function witness(
  driver: WitnessDriver,
  name: string,
  options: WitnessOptions = {},
): Promise<void> {
  assertArguments(driver, name);
  const localConfig = loadLocalConfig(process.cwd());
  const session = await readSession(driver);
  name = snapshotKey(name, options, session, localConfig);
  const plan = capturePlan(options, localConfig);

  const { png: screenshot, method: captureMethod, health } = await shoot(driver, plan, options);
  const dom = await readDom(driver, options, plan.ignoreSelectors);
  const elementMap = await readElementMap(driver, options, plan);

  // Write to .testivai/temp/<name>/
  const store = new BaselineStore(process.cwd());
  store.writeTemp(name, screenshot, dom);
  recordEnvironment(store, name, session, captureMethod);
  recordCaptureHealth(store, name, health);
  refreshShardManifest();
  writeElementMap(store, name, elementMap, plan.idAttributes);
}
