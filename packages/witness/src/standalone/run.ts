/**
 * Standalone witness mode — orchestrator.
 *
 * `testivai witness http://localhost:3000` with no test suite:
 *   1. find or launch headless Chrome
 *   2. resolve pages (config/flags, or same-origin crawl of the start page)
 *   3. per page: stabilize → full-page screenshot + DOM → BaselineStore temp
 *   4. compare against baselines → HTML report + results.json
 *
 * Everything downstream of capture (diff, tolerances, noise hint, report,
 * approve, GitHub Action) is the exact same pipeline the test-suite adapters
 * feed. The capture itself differs: no element map is written, so regions
 * stay unattributed, no page shift is detected, and the computed-style check
 * has nothing to compare (dom.styleCheck is 'unavailable', a stylesheet-only
 * change is not ruled out, and noiseAutoPass never passes these snapshots).
 * Capture health is recorded: the in-page probe after the capture, plus what
 * the crawler saw on the network (failed requests, cross-origin ones
 * included), so a page whose fonts or stylesheets failed reads as an
 * unhealthy capture.
 */

import CDP from 'chrome-remote-interface';
import chalk from 'chalk';
import { BaselineStore } from '../baselines/store';
import {
  applyEnvironmentPolicyToName,
  browserFromUserAgent,
  buildCaptureEnvironment,
  CAPTURE_METHODS,
  collectHostEnvironment,
  parseRenderProbe,
  RENDER_PROBE_EXPRESSION,
  type CaptureEnvironment,
  type HostEnvironment,
} from '../capture/environment';
import {
  type CaptureHealth,
  HEALTH_PROBE_EXPRESSION,
  isBrowserFaviconRequest,
  mergeResourceFailures,
  parseHealth,
  type ResourceFailure,
  resourceTypeFromCdp,
} from '../capture/health';
import { loadLocalConfig } from '../config/local-config';
import { generateReport } from '../report/generator';
import { logger } from '../utils/logger';
import { FRESH_FRAME_EXPRESSION, captureUntilStable, settleFreshFrame } from '../capture/stable-capture';
import { filterCrawledLinks, pageNameFromUrl, resolvePages } from './crawl';
import { findChrome, launchChrome, type LaunchedChrome } from './launcher';

/** Mirrors the adapters' stabilization CSS (see packages/playwright config/stabilize):
 * near-zero durations complete animations at their FINAL state, so pages
 * with entry animations render fully instead of freezing hidden. */
const STABILIZE_CSS =
  '*, *::before, *::after { animation-duration: 0.001s !important; animation-delay: 0s !important; ' +
  'animation-iteration-count: 1 !important; transition-duration: 0.001s !important; ' +
  'transition-delay: 0s !important; caret-color: transparent !important; scroll-behavior: auto !important; }';

export interface StandaloneOptions {
  /** Explicit page paths; disables crawling when provided. */
  pages?: string[];
  /** Crawl cap when discovering links. Default 10. */
  maxPages?: number;
  viewport?: { width: number; height: number };
  /** Reuse an already-running debuggable Chrome on this port. */
  port?: number;
}

interface PageClient {
  client: any;
  targetId: string;
}

async function evaluate<T>(client: any, expression: string): Promise<T | undefined> {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true });
  return result?.result?.value as T | undefined;
}

async function waitFor(
  client: any,
  expression: string,
  timeoutMs: number,
  intervalMs = 150,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await evaluate<boolean>(client, expression)) === true) return;
    } catch {
      // page mid-navigation; retry
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** How long to wait for a page to load before capturing it anyway. */
const PAGE_LOAD_TIMEOUT_MS = 15_000;

/**
 * True once the tab shows the page it was sent to, fully loaded. A new tab
 * starts on about:blank, which already reports readyState 'complete', and
 * keeps showing it until the page's response arrives, so readyState alone
 * would pass before the page has even started loading.
 */
const PAGE_LOADED = `location.href !== 'about:blank' && document.readyState === 'complete'`;

/**
 * Open a tab, apply `viewport` when given, then load `url` and wait until the
 * tab shows that page, loaded. Closes the tab again when that fails.
 *
 * Opening the tab on `url` directly and waiting for readyState 'complete'
 * returned while the tab still showed about:blank: on the first page of a
 * freshly launched Chrome, or any page of a server that takes a moment to
 * answer. The stabilization CSS and ignoreSelectors then went into
 * about:blank and were lost, the font wait and reveal pass ran on it, and
 * the capture raced the real page's entry animations. The viewport is applied
 * before the page is requested, so the page never loads at another size.
 * `prepare` runs before the page is requested too (watchNetwork, so every
 * request the page makes is seen).
 *
 * Exported for testing.
 */
export async function openPage(
  port: number,
  url: string,
  viewport?: { width: number; height: number },
  prepare?: (client: any) => void | Promise<void>,
): Promise<PageClient> {
  const target = await CDP.New({ port });
  const page: PageClient = { client: null, targetId: target.id };
  try {
    page.client = await CDP({ port, target: target.id });
    await Promise.all([page.client.Page.enable(), page.client.Runtime.enable()]);
    if (prepare) await prepare(page.client);
    if (viewport) {
      await page.client.Emulation.setDeviceMetricsOverride({
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    await page.client.Page.navigate({ url });
    await waitFor(page.client, PAGE_LOADED, PAGE_LOAD_TIMEOUT_MS);
    return page;
  } catch (err) {
    await closePage(port, page);
    throw err;
  }
}

async function closePage(port: number, page: PageClient): Promise<void> {
  try {
    if (page.client) await page.client.close();
  } catch {
    /* already closed */
  }
  try {
    await CDP.Close({ port, id: page.targetId });
  } catch {
    /* target already gone */
  }
}

/** Stabilize + hide ignored elements. Returns true when the style tag was injected. */
async function prepPage(
  client: any,
  stabilize: boolean,
  ignoreSelectors: string[],
): Promise<void> {
  const cssParts: string[] = [];
  if (stabilize) cssParts.push(STABILIZE_CSS);
  if (ignoreSelectors.length > 0) {
    cssParts.push(ignoreSelectors.map((s) => `${s} { visibility: hidden !important; }`).join('\n'));
  }
  if (cssParts.length === 0) return;

  await evaluate(
    client,
    `(() => { const el = document.createElement('style');` +
      ` el.textContent = ${JSON.stringify(cssParts.join('\n'))};` +
      ` document.head.appendChild(el); return true; })()`,
  );
  if (stabilize) {
    // Remote sites load webfonts over the real network from a cold profile;
    // a fallback-font capture diffs 30%+ against a webfont baseline. Wait
    // generously — resolves in well under a second once fonts are cached
    // by the OS/network layer.
    await waitFor(client, `document.fonts ? document.fonts.status !== 'loading' : true`, 10_000);
    await evaluate(client, `document.fonts && document.fonts.ready`); // settle
  }
}

/**
 * Serialize the DOM with ignored elements removed. `ignoreSelectors`
 * excludes an element from the pixel diff (visibility:hidden), so it must
 * be excluded from the DOM/text signal too — otherwise dynamic ignored
 * content (counters, feeds) flags a DOM change the pixels can't show.
 */
function domSnapshotExpression(ignoreSelectors: string[]): string {
  return `(() => {
    const clone = document.documentElement.cloneNode(true);
    for (const sel of ${JSON.stringify(ignoreSelectors)}) {
      try { clone.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
    }
    return clone.outerHTML;
  })()`;
}

/**
 * Scroll stepwise through the page (viewport-height hops, bounded), then
 * back to the top. Fires IntersectionObserver reveal-on-scroll content that
 * a headless capture would otherwise never render — without resizing the
 * viewport, which would explode 100vh-based layouts.
 */
async function revealPage(client: any): Promise<void> {
  try {
    await client.Runtime.evaluate({
      expression: `(async () => {
        const step = window.innerHeight || 800;
        const max = Math.min(document.documentElement.scrollHeight, step * 40);
        for (let y = 0; y <= max; y += step) {
          window.scrollTo(0, y);
          await new Promise(r => setTimeout(r, 120));
        }
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 250));
        return true;
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
  } catch {
    // best-effort: capture proceeds from the top either way
  }
}

/** Debug sink for the shared capture helpers, prefixed for this mode. */
const captureLog = (message: string) => logger.debug(`standalone capture: ${message}`);

/**
 * Evaluate the shared fresh-frame wait (FRESH_FRAME_EXPRESSION) in the page.
 * Resolves whether two frames were rendered: false when the in-page wait timed
 * out, or failed because the page navigated.
 */
async function waitForFreshFrame(client: any): Promise<boolean> {
  try {
    const result = await client.Runtime.evaluate({
      expression: FRESH_FRAME_EXPRESSION,
      awaitPromise: true,
      returnByValue: true,
    });
    return result?.result?.value === true;
  } catch {
    return false;
  }
}

/**
 * Wait for a freshly rendered frame before capturing (retried once; see
 * capture/stable-capture.ts for why a stale frame happens). Best-effort,
 * never blocking.
 */
function settleFrame(client: any): Promise<void> {
  return settleFreshFrame(() => waitForFreshFrame(client), captureLog);
}

async function screenshot(client: any, width: number, height: number): Promise<string> {
  const shot = await client.Page.captureScreenshot({
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  return shot.data;
}

/** Full-page screenshot via layout metrics (same technique as the Playwright adapter's CDP path). Exported for testing. */
export async function captureFullPage(client: any): Promise<Buffer> {
  await settleFrame(client);

  // Freshly-launched Chrome can report zero-size content before its first
  // real layout — poll briefly until metrics are usable.
  let width = 0;
  let height = 0;
  let polled = false;
  const deadline = Date.now() + 5000;
  for (;;) {
    const metrics = await client.Page.getLayoutMetrics();
    width = Math.ceil(metrics.cssContentSize?.width ?? metrics.contentSize.width);
    height = Math.ceil(metrics.cssContentSize?.height ?? metrics.contentSize.height);
    if ((width > 0 && height > 0) || Date.now() >= deadline) break;
    polled = true;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (width <= 0 || height <= 0) {
    throw new Error(`page reported unusable content size ${width}x${height}`);
  }
  // The frame waited for above predates the layout the poll waited for, so
  // it may not show it: wait for a frame rendered after that layout.
  if (polled) await settleFrame(client);

  // Even after two fresh frames, Page.captureScreenshot now and then returns
  // the page laid out for a near-zero viewport (narrow media rules, a
  // collapsed 100vh hero), most likely from the 1x1 view Chrome emulates for
  // a moment while it sets up a beyond-viewport capture. The capture after
  // it is almost always right, so capture until two captures in a row match.
  const data = await captureUntilStable({
    capture: () => screenshot(client, width, height),
    settle: () => settleFrame(client),
    log: captureLog,
  });
  return Buffer.from(data, 'base64');
}

/**
 * Capture provenance for `testivai witness <url>`: its own headless Chrome,
 * full-page CDP screenshots, no test framework. The version comes from CDP
 * Browser.getVersion's product ("HeadlessChrome/141.0.7390.54"), else the
 * probe's user agent; never guessed.
 */
export function standaloneEnvironment(input: { probe: unknown; product: string | undefined; host?: HostEnvironment }): CaptureEnvironment {
  const probed = parseRenderProbe(input.probe);
  const fromProduct = input.product ? browserFromUserAgent(input.product) : null;
  const fromUa = probed?.userAgent ? browserFromUserAgent(probed.userAgent) : null;
  const known = fromProduct ?? fromUa;
  const browser: CaptureEnvironment['browser'] = { name: 'chromium', version: known?.version ?? null };
  if (known?.headless) browser.headless = true;
  return buildCaptureEnvironment({
    host: input.host ?? collectHostEnvironment(),
    browser,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    adapter: { name: '@testivai/witness', version: require('../../package.json').version, captureMethod: CAPTURE_METHODS.CDP_FULL_PAGE },
    render: probed?.render,
  });
}

/** The failed requests a page made, as watchNetwork saw them. */
export interface NetworkWatch {
  failures(): ResourceFailure[];
}

/**
 * Watch a tab's requests (CDP Network events) for capture health: each
 * request that answered 400 or more, or failed without a response. Not the
 * page itself (a Document), a request the page cancelled, or Chrome's
 * net::ERR_ABORTED without a status (a 404'd stylesheet or font is reported
 * both as a response and as aborted: the status wins). Call before the page is
 * requested. Exported for testing.
 */
export async function watchNetwork(client: any): Promise<NetworkWatch> {
  interface Seen {
    url: string;
    type?: string;
    status?: number;
    error?: string;
    canceled?: boolean;
  }
  const requests = new Map<string, Seen>();
  const seen = (id: unknown, url?: unknown, type?: unknown): Seen | undefined => {
    if (typeof id !== 'string') return undefined;
    let request = requests.get(id);
    if (!request && typeof url === 'string') requests.set(id, (request = { url }));
    if (request && typeof type === 'string' && !request.type) request.type = type;
    return request;
  };
  client.on('Network.requestWillBeSent', (e: any) => {
    const request = seen(e?.requestId, e?.request?.url, e?.type);
    if (request && typeof e?.request?.url === 'string') request.url = e.request.url; // a redirect's new address
  });
  client.on('Network.responseReceived', (e: any) => {
    const request = seen(e?.requestId, e?.response?.url, e?.type);
    if (request && typeof e?.response?.status === 'number') request.status = e.response.status;
  });
  client.on('Network.loadingFailed', (e: any) => {
    const request = seen(e?.requestId, undefined, e?.type);
    if (!request) return;
    if (typeof e?.errorText === 'string') request.error = e.errorText;
    request.canceled = e?.canceled === true;
  });
  await client.Network.enable();
  return {
    failures() {
      const out: ResourceFailure[] = [];
      for (const r of requests.values()) {
        if (r.type === 'Document' || !/^https?:/i.test(r.url)) continue;
        if (r.type === 'Other' && isBrowserFaviconRequest(r.url)) continue;
        const type = resourceTypeFromCdp(r.type);
        if (r.status !== undefined) {
          if (r.status >= 400) out.push({ url: r.url, type, status: r.status });
        } else if (r.error && !r.canceled && r.error !== 'net::ERR_ABORTED') {
          out.push({ url: r.url, type, status: 0, error: r.error });
        }
      }
      return out;
    },
  };
}

/**
 * A page's capture health: the probe's result, with the failed requests the
 * network watch saw merged in (null when the network was not watched). Null
 * without a valid probe result: not checked. Exported for testing.
 */
export function standaloneHealth(probe: unknown, failures: ResourceFailure[] | null): CaptureHealth | null {
  const health = parseHealth(probe);
  if (!health) return null;
  return failures ? mergeResourceFailures(health, failures) : health;
}

export async function runStandaloneWitness(
  startUrl: string,
  options: StandaloneOptions,
): Promise<void> {
  const projectRoot = process.cwd();
  const config = loadLocalConfig(projectRoot);
  const viewport = options.viewport ?? config.viewport ?? { width: 1280, height: 800 };
  const maxPages = options.maxPages ?? config.maxPages ?? 10;
  const explicitPages = options.pages ?? config.pages;

  // 1. Browser: reuse a provided port, else launch our own headless Chrome
  let launched: LaunchedChrome | null = null;
  let port = options.port ?? 0;
  if (!port) {
    const executable = findChrome();
    if (!executable) {
      throw new Error(
        'No Chrome/Chromium found. Install Google Chrome, or set TESTIVAI_CHROME_PATH to a Chrome binary ' +
          '(a Playwright-downloaded chromium works: npx playwright install chromium).',
      );
    }
    port = 9222 + Math.floor(Math.random() * 800);
    launched = await launchChrome(executable, port);
  }

  const store = new BaselineStore(projectRoot);
  const captured: string[] = [];

  try {
    // 2. Resolve the page list
    let pages: string[];
    if (explicitPages && explicitPages.length > 0) {
      pages = resolvePages(startUrl, explicitPages);
    } else {
      const first = await openPage(port, startUrl);
      const hrefs =
        (await evaluate<string[]>(
          first.client,
          `Array.from(document.querySelectorAll('a[href]')).map(a => a.href)`,
        )) ?? [];
      await closePage(port, first);
      pages = filterCrawledLinks(startUrl, hrefs, maxPages);
    }

    logger.info(`Witnessing ${pages.length} page(s) at ${viewport.width}x${viewport.height}`);

    // 3. Capture every page
    for (const url of pages) {
      // This crawler only drives Chrome, so "separate" keys by chromium.
      const name = applyEnvironmentPolicyToName(
        pageNameFromUrl(url),
        { browser: { name: 'chromium' }, os: { platform: process.platform } },
        config.environmentPolicy,
      );
      let page: PageClient | undefined;
      let network: NetworkWatch | null = null;
      try {
        page = await openPage(port, url, viewport, async (client) => {
          try {
            network = await watchNetwork(client);
          } catch {
            network = null; // the probe still records what the page can see
          }
        });
        // Capture provenance: measured before anything is injected.
        const probe = await evaluate<unknown>(page.client, RENDER_PROBE_EXPRESSION).catch(() => undefined);
        const product = await Promise.resolve(page.client.Browser?.getVersion?.())
          .then((v: { product?: string } | undefined) => v?.product)
          .catch(() => undefined);
        await prepPage(page.client, config.stabilize, config.ignoreSelectors ?? []);
        await revealPage(page.client);

        const screenshot = await captureFullPage(page.client);
        const dom = await evaluate<string>(page.client, domSnapshotExpression(config.ignoreSelectors ?? []));
        // Capture health, read after the capture so it sees what loaded.
        const healthProbe = await evaluate<unknown>(page.client, HEALTH_PROBE_EXPRESSION).catch(() => undefined);
        store.writeTemp(name, screenshot, typeof dom === 'string' ? dom : undefined);
        try {
          store.writeTempMetadata(name, { name, environment: standaloneEnvironment({ probe, product }) });
        } catch {
          // without it the compare cannot tell rendering drift from noise for this page
        }
        try {
          const watched = network as NetworkWatch | null;
          const health = standaloneHealth(healthProbe, watched ? watched.failures() : null);
          if (health) store.writeTempMetadata(name, { health });
        } catch {
          // no health only means this page's capture health was not checked
        }

        captured.push(name);
        console.log(chalk.gray(`  ✓ ${name}  (${url})`));
      } catch (err) {
        console.log(chalk.yellow(`  ⚠ skipped ${name}: ${(err as Error).message}`));
      } finally {
        if (page) await closePage(port, page);
      }
    }
  } finally {
    if (launched) launched.kill();
  }

  if (captured.length === 0) {
    throw new Error('No pages captured. Is the app running at that URL?');
  }

  // 4. Diff + report through the standard pipeline (tolerances from config.json)
  const report = generateReport({
    projectRoot,
    reportDir: config.reportDir ?? 'visual-report',
    threshold: config.threshold,
    autoOpen: config.autoOpen,
    version: require('../../package.json').version,
  });

  const { summary } = report;
  console.log();
  console.log(chalk.cyan.bold('  ═══ TestivAI Visual Report ═══'));
  console.log(
    `  Total: ${summary.total}  |  Passed: ${summary.passed}  |  Changed: ${summary.changed}  |  New: ${summary.newSnapshots}`,
  );
  if (summary.newSnapshots > 0) {
    console.log(chalk.gray('  New baselines: npx testivai approve --all   (then commit .testivai/baselines/)'));
  }
  if (summary.changed > 0) {
    console.log(chalk.gray(`  Review: ${config.reportDir ?? 'visual-report'}/index.html — approve with: npx testivai approve <name>`));
  }

  if (config.failOnDiff && summary.changed > 0) {
    process.exitCode = 1;
  }
}
