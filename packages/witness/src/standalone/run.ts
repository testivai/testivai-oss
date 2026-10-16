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
 */

import CDP from 'chrome-remote-interface';
import chalk from 'chalk';
import { BaselineStore } from '../baselines/store';
import { loadLocalConfig } from '../config/local-config';
import { generateReport } from '../report/generator';
import { logger } from '../utils/logger';
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
 *
 * Exported for testing.
 */
export async function openPage(
  port: number,
  url: string,
  viewport?: { width: number; height: number },
): Promise<PageClient> {
  const target = await CDP.New({ port });
  const page: PageClient = { client: null, targetId: target.id };
  try {
    page.client = await CDP({ port, target: target.id });
    await Promise.all([page.client.Page.enable(), page.client.Runtime.enable()]);
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

/**
 * Resolves once the page has rendered two animation frames, i.e. a frame
 * produced after every style and layout change made so far has been painted.
 * The timeout bounds the wait for a page that renders no frames at all.
 */
const FRESH_FRAME_SCRIPT = `new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 1000);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    clearTimeout(timer);
    resolve(true);
  }));
})`;

/**
 * Wait for a freshly rendered frame before capturing. Without it,
 * Page.captureScreenshot could return a stale frame: the page measured
 * correctly, but the pixels showed styles resolved against an earlier
 * viewport (a collapsed 100vh hero, narrow-viewport media rules), so
 * identical pages flipped between two renders from run to run. A forced
 * layout alone does not prevent this; a rendered frame does.
 *
 * Returns whether two frames were rendered: false when the in-page wait
 * timed out, or failed because the page navigated.
 */
async function waitForFreshFrame(client: any): Promise<boolean> {
  try {
    const result = await client.Runtime.evaluate({
      expression: FRESH_FRAME_SCRIPT,
      awaitPromise: true,
      returnByValue: true,
    });
    return result?.result?.value === true;
  } catch {
    return false;
  }
}

/**
 * Wait for a fresh frame, retrying once when none arrived in time (a loaded
 * machine can stall a frame past the in-page timeout). If neither attempt
 * sees one, the capture still proceeds: best-effort, never blocking.
 */
async function settleFrame(client: any): Promise<void> {
  if (await waitForFreshFrame(client)) return;
  logger.debug('standalone capture: no fresh frame within the wait; waiting once more');
  if (await waitForFreshFrame(client)) return;
  logger.debug('standalone capture: no fresh frame after a retry; capturing anyway, the screenshot may be stale');
}

/**
 * The most captures of one page while waiting for two in a row to match.
 * Every stale-capture pattern measured settles within four (stale, good,
 * good / good, stale, good, good); a page that never stops animating costs
 * four captures, not an endless loop.
 */
const MAX_CAPTURES = 4;

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
  // That wrong frame is the same pixels every time, so two of them in a row
  // still match and are kept: rare, since it takes two misses, but possible.
  let previous = await screenshot(client, width, height);
  for (let captures = 1; captures < MAX_CAPTURES; captures++) {
    await settleFrame(client);
    const current = await screenshot(client, width, height);
    if (current === previous) return Buffer.from(current, 'base64');
    logger.debug('standalone capture: two captures in a row differed; capturing again');
    previous = current;
  }
  logger.debug(`standalone capture: no two captures in a row matched in ${MAX_CAPTURES}; keeping the last`);
  return Buffer.from(previous, 'base64');
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
      const name = pageNameFromUrl(url);
      let page: PageClient | undefined;
      try {
        page = await openPage(port, url, viewport);
        await prepPage(page.client, config.stabilize, config.ignoreSelectors ?? []);
        await revealPage(page.client);

        const screenshot = await captureFullPage(page.client);
        const dom = await evaluate<string>(page.client, domSnapshotExpression(config.ignoreSelectors ?? []));
        store.writeTemp(name, screenshot, typeof dom === 'string' ? dom : undefined);

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
