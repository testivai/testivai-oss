import type { Page, TestInfo } from '@playwright/test';
import * as fs from 'fs-extra';
import * as path from 'path';
import { URL } from 'url';
import sharp from 'sharp';
import type { TestivAIConfig } from './types';
import { loadConfig, mergeTestConfig } from './config/loader';
import { collectIgnoreSelectors, collectIgnoreRules, buildIgnoreSelectorsCSS } from './config/ignore-selectors';
import { buildElementMapExpression } from './capture/element-map';
import { STABILIZE_CSS, resolveStabilize, waitForFonts, waitForSettled, stopSettleObserver } from './config/stabilize';
import { captureFullPageScreenshot } from './capture/full-page';

/**
 * Generates a safe filename from a URL.
 * @param pageUrl The URL of the page.
 * @returns A sanitized string suitable for a filename.
 */
function getSnapshotNameFromUrl(pageUrl: string): string {
  // Handle data URIs, which are common in test environments
  if (pageUrl.startsWith('data:')) {
    return 'snapshot';
  }

  try {
    const url = new URL(pageUrl);
    const pathName = url.pathname.substring(1).replace(/\//g, '_'); // remove leading slash and replace others
    return pathName || 'home';
  } catch (_error) {
    // Fallback for invalid URLs
    return 'snapshot';
  }
}

/**
 * Compute the effective snapshot name, folding in a project variant when the
 * Playwright config runs multiple projects. Without this, two projects (e.g.
 * chromium-desktop and mobile-safari) capturing the same snapshot name would
 * overwrite each other's baselines under .testivai/baselines/<name>/.
 *
 * Single-project configs are untouched: 'homepage' stays 'homepage'.
 * Multi-project configs get 'homepage__chromium', 'homepage__mobile-safari'.
 * The variant lives in the NAME, so the on-disk layout, results.json schema,
 * report, approve CLI, and PR-comment approvals all work unchanged.
 */
export function effectiveSnapshotName(baseName: string, testInfo: TestInfo): string {
  const projects = (testInfo as any)?.config?.projects;
  const projectName = (testInfo as any)?.project?.name;
  if (!Array.isArray(projects) || projects.length <= 1) return baseName;
  if (typeof projectName !== 'string' || projectName.length === 0) return baseName;
  const safeVariant = projectName.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  return `${baseName}__${safeVariant}`;
}

/**
 * Captures a snapshot of the page, including a screenshot, DOM, and layout data.
 * The evidence is stored in a temporary directory for the reporter to process later.
 *
 * @param page The Playwright Page object.
 * @param testInfo The Playwright TestInfo object, passed from the test.
 * @param name An optional unique name for the snapshot. If not provided, a name is generated from the URL.
 * @param config Optional TestivAI configuration for this snapshot (overrides project defaults).
 */
export async function snapshot(
  page: Page,
  testInfo: TestInfo,
  name?: string,
  config?: TestivAIConfig
): Promise<void> {
  // Load project configuration and merge with test-specific overrides
  const projectConfig = await loadConfig();
  const effectiveConfig = mergeTestConfig(projectConfig, config);

  // Debug: Log config
  if (process.env.TESTIVAI_DEBUG === 'true') {
    console.log('[TestivAI] Config:', {
      projectConfig,
      testConfig: config,
      effectiveConfig
    });
  }

  const outputDir = path.join(process.cwd(), '.testivai', 'temp');
  await fs.ensureDir(outputDir);

  const snapshotName = effectiveSnapshotName(name || getSnapshotNameFromUrl(page.url()), testInfo);
  const timestamp = Date.now();
  const safeName = snapshotName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const baseFilename = `${timestamp}_${safeName}`;

  // 1. Capture full-page screenshot
  const screenshotPath = path.join(outputDir, `${baseFilename}.png`);

  // Hide elements matching ignoreSelectors before the screenshot so dynamic
  // content (version badges, timestamps, ads) doesn't cause false diffs.
  // Sources (merged, deduped) — see config/ignore-selectors.ts:
  //   1. .testivai/config.json  → ignoreSelectors  (global config)
  //   2. testivai.config.ts     → ignoreSelectors  (global, power users)
  //   3. testivai.witness(...)  → { ignoreSelectors } (per-snapshot override)
  let ignoreStyleEl: import('@playwright/test').ElementHandle | null = null;
  {
    // Rules carry per-selector mode: mask (visibility:hidden, layout kept) or
    // collapse (display:none, layout removed — fixes variable-height shift).
    const ignoreRules = collectIgnoreRules(process.cwd(), projectConfig, effectiveConfig);
    const css = buildIgnoreSelectorsCSS(ignoreRules);
    if (css) {
      ignoreStyleEl = await page.addStyleTag({ content: css });
    }
  }

  // Stabilize the page before capture: freeze CSS animations and
  // transitions, hide the caret, and wait for web fonts — the top sources of
  // flaky pixel diffs. Injected as CSS so every capture path (native
  // screenshot, CDP captureScreenshot, scroll-and-stitch) is covered.
  let stabilizeStyleEl: import('@playwright/test').ElementHandle | null = null;
  if (resolveStabilize(process.cwd(), projectConfig, config)) {
    try {
      stabilizeStyleEl = await page.addStyleTag({ content: STABILIZE_CSS });
    } catch {
      // Style injection can fail on locked-down pages; capture proceeds
    }
    await waitForFonts(page);
    // Then wait for the page itself to stop changing — images finished, DOM
    // quiet. This is the load question the DOM/style layer cannot answer:
    // content that never arrived reads as a real change, not as noise.
    await waitForSettled(page);
  }

  // Check if scroll-and-stitch is explicitly requested (backup method)
  if (effectiveConfig.useBrowserCapture === false) {
    // Use scroll-and-stitch approach (backup method)
    if (process.env.TESTIVAI_DEBUG === 'true') {
      console.log('[TestivAI] Using scroll-and-stitch approach (backup method)');
    }
    
    // Get viewport dimensions
    const viewport = page.viewportSize();
    const viewportWidth = viewport?.width || 1280;
    const viewportHeight = viewport?.height || 720;
    
    // Find the main scrollable container and get its dimensions
    const scrollableInfo = await page.evaluate(`
    (function() {
      var mainScrollable = null;
      var maxScrollHeight = 0;
      
      // Find the element with the most scrollable content
      document.querySelectorAll('*').forEach(function(el) {
        var computed = window.getComputedStyle(el);
        var isScrollable = (
          computed.overflowY === 'auto' || 
          computed.overflowY === 'scroll'
        );
        
        if (isScrollable && el.scrollHeight > el.clientHeight) {
          if (el.scrollHeight > maxScrollHeight) {
            maxScrollHeight = el.scrollHeight;
            mainScrollable = el;
          }
        }
      });
      
      // If we found a scrollable container, add a temporary ID
      if (mainScrollable) {
        if (!mainScrollable.id) {
          mainScrollable.id = '__testivai_scrollable_' + Date.now();
        }
        return {
          hasScrollable: true,
          scrollableId: mainScrollable.id,
          scrollHeight: mainScrollable.scrollHeight,
          clientHeight: mainScrollable.clientHeight,
          scrollTop: mainScrollable.scrollTop
        };
      }
      
      // Fallback to document scroll
      return {
        hasScrollable: false,
        scrollableId: null,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: window.innerHeight,
        scrollTop: window.scrollY
      };
    })()
  `) as { 
    hasScrollable: boolean; 
    scrollableId: string | null; 
    scrollHeight: number; 
    clientHeight: number;
    scrollTop: number;
  };
  
  // Calculate number of screenshots needed
  const totalHeight = scrollableInfo.scrollHeight;
  const captureHeight = scrollableInfo.clientHeight;
  const numCaptures = Math.ceil(totalHeight / captureHeight);
  
  // Debug logging (only when TESTIVAI_DEBUG is enabled)
  if (process.env.TESTIVAI_DEBUG === 'true') {
    console.log(`[TestivAI] Scroll-and-stitch info:`, {
      hasScrollable: scrollableInfo.hasScrollable,
      scrollableId: scrollableInfo.scrollableId,
      totalHeight,
      captureHeight,
      numCaptures,
      viewportWidth,
      viewportHeight
    });
  }
  
  // If only one capture needed, just take a regular screenshot
  if (numCaptures <= 1) {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } else {
    // Scroll-and-stitch approach
    const screenshots: Buffer[] = [];
    
    for (let i = 0; i < numCaptures; i++) {
      const scrollPosition = i * captureHeight;
      
      // Scroll to position
      if (scrollableInfo.hasScrollable && scrollableInfo.scrollableId) {
        await page.evaluate(`
          document.getElementById('${scrollableInfo.scrollableId}').scrollTop = ${scrollPosition};
        `);
      } else {
        await page.evaluate(`window.scrollTo(0, ${scrollPosition})`);
      }
      
      // Wait for scroll and any lazy-loaded content
      await page.waitForTimeout(100);
      
      // Capture this viewport
      const screenshotBuffer = await page.screenshot({ fullPage: false });
      screenshots.push(screenshotBuffer);
    }
    
    // Stitch screenshots together using sharp
    // Calculate the actual height of the last capture (may be partial)
    const lastCaptureHeight = totalHeight - (captureHeight * (numCaptures - 1));
    
    // Create composite image
    const compositeInputs = screenshots.map((buffer, index) => {
      const isLast = index === screenshots.length - 1;
      const yOffset = index * captureHeight;
      
      // For the last screenshot, we need to crop from the bottom
      if (isLast && lastCaptureHeight < captureHeight) {
        return {
          input: buffer,
          top: yOffset,
          left: 0,
          // We'll handle the cropping separately
        };
      }
      
      return {
        input: buffer,
        top: yOffset,
        left: 0,
      };
    });
    
    // Create the final stitched image
    const finalImage = sharp({
      create: {
        width: viewportWidth,
        height: totalHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    });
    
    // Composite all screenshots
    const stitchedImage = await finalImage
      .composite(compositeInputs)
      .png()
      .toBuffer();
    
    await fs.writeFile(screenshotPath, stitchedImage);
    
    // Restore original scroll position
    if (scrollableInfo.hasScrollable && scrollableInfo.scrollableId) {
      await page.evaluate(`
        document.getElementById('${scrollableInfo.scrollableId}').scrollTop = ${scrollableInfo.scrollTop};
      `);
    } else {
      await page.evaluate(`window.scrollTo(0, ${scrollableInfo.scrollTop})`);
    }
  }
  } else {
    // Use browser capture approach (default)
    if (process.env.TESTIVAI_DEBUG === 'true') {
      console.log('[TestivAI] Using browser capture approach (default) for full-page screenshot');
    }
    
    try {
      // Create a browser session
      const client = await page.context().newCDPSession(page);
      
      // Enable Page domain
      await client.send('Page.enable');
      
      // Temporarily remove height constraints to get the full scrollable content
      await page.addStyleTag({
        content: `
          html, body {
            height: auto !important;
            min-height: auto !important;
            max-height: none !important;
          }
          #testivai-layout-root, [class*="h-screen"] {
            height: auto !important;
            min-height: auto !important;
            max-height: none !important;
            overflow: visible !important;
          }
        `
      });
      
      // Wait a bit for styles to apply
      await page.waitForTimeout(100);
      
      // Wait for a fresh frame, measure, and capture beyond the viewport until
      // two captures in a row match: Chrome can return a frame painted for the
      // wrong viewport while it sets up the capture (capture/full-page.ts).
      const captureLog = process.env.TESTIVAI_DEBUG === 'true'
        ? (message: string) => console.log(`[TestivAI] Full-page capture: ${message}`)
        : undefined;
      const png = await captureFullPageScreenshot(page, client, captureLog);

      // Save the screenshot
      await fs.writeFile(screenshotPath, png);
      
      // Remove the temporary style tag
      await page.evaluate(`
        const styleTags = document.querySelectorAll('style');
        // Remove the last added style tag (our temporary one)
        if (styleTags.length > 0) {
          styleTags[styleTags.length - 1].remove();
        }
      `);
      
      // Close browser session
      await client.detach();
      
    } catch (error: any) {
      console.error('[TestivAI] Browser screenshot failed:', error.message);
      // Fallback to regular screenshot
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
  }

  // Restore any elements hidden for ignoreSelectors
  if (ignoreStyleEl) {
    await ignoreStyleEl.evaluate((el: Element) => el.remove()).catch(() => {});
    ignoreStyleEl = null;
  }

  // Re-enable animations/transitions after capture
  if (stabilizeStyleEl) {
    await stabilizeStyleEl.evaluate((el: Element) => el.remove()).catch(() => {});
    stabilizeStyleEl = null;
    await stopSettleObserver(page);
  }

  // 1.5. Place the screenshot in the layout expected by
  //      @testivai/witness/report (subdirectory keyed by snapshot name).
  //      This is what `BaselineStore.listTemp()` and `compareAll()` enumerate.
  //
  //      DOM HTML is captured here too — written as `dom.html` next to the
  //      screenshot. compareAll() uses this to produce the noise-hint signal
  //      ("pixels differ but DOM is unchanged → likely render noise"). DOM
  //      capture is wrapped in try/catch so a flaky page never breaks the
  //      screenshot path; missing dom.html simply suppresses the hint.
  {
    const localSnapshotDir = path.join(outputDir, snapshotName);
    await fs.ensureDir(localSnapshotDir);
    // Move (not copy) the flat capture into the canonical <name>/ layout so
    // local mode leaves exactly one on-disk representation — no stray
    // <timestamp>_<name>.png alongside it. The flat metadata .json is also
    // skipped in local mode (see below); the local report reads the <name>/
    // directory, not the flat files.
    await fs.move(screenshotPath, path.join(localSnapshotDir, 'screenshot.png'), { overwrite: true });

    try {
      const domIgnoreSelectors = collectIgnoreSelectors(process.cwd(), projectConfig, effectiveConfig);
      const domHtml = await page.evaluate((selectors: string[]) => {
        // ignoreSelectors excludes elements from the pixel diff, so they
        // are excluded from the DOM/text signal too (consistent semantic)
        const clone = document.documentElement.cloneNode(true) as HTMLElement;
        for (const sel of selectors) {
          try { clone.querySelectorAll(sel).forEach((el) => { el.remove(); }); } catch {}
        }
        return clone.outerHTML;
      }, domIgnoreSelectors);
      if (typeof domHtml === 'string' && domHtml.length > 0) {
        await fs.writeFile(
          path.join(localSnapshotDir, 'dom.html'),
          domHtml,
          'utf-8'
        );
      }
    } catch (err: unknown) {
      if (process.env.TESTIVAI_DEBUG === 'true') {
        console.warn('[TestivAI] DOM capture failed (noise-hint will be unavailable):', err);
      }
    }

    // Mask support: record per-call mask specs and capture geometry for
    // every selector mask (config + per-call) via getBoundingClientRect.
    // The DOM snapshot carries no layout, so comparison-time selector
    // masks depend on these rects; when absent, the compare degrades to
    // a visible warning. Best-effort — never breaks the capture.
    try {
      const perCallMasks = effectiveConfig.mask ?? [];
      const configMaskEntries = readConfigMasks(process.cwd());
      const selectorMasks = [
        ...configMaskEntries.filter((m): m is string => typeof m === 'string'),
        ...perCallMasks.filter((m): m is string => typeof m === 'string'),
      ];
      const uniqueSelectors = [...new Set(selectorMasks)];

      let maskRects: Array<{ selector: string; x: number; y: number; width: number; height: number }> = [];
      if (uniqueSelectors.length > 0) {
        maskRects = await page.evaluate((selectors: string[]) => {
          const dpr = window.devicePixelRatio || 1;
          const out: Array<{ selector: string; x: number; y: number; width: number; height: number }> = [];
          for (const sel of selectors) {
            try {
              document.querySelectorAll(sel).forEach((el) => {
                const r = (el as HTMLElement).getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                  out.push({
                    selector: sel,
                    x: Math.round((r.x + window.scrollX) * dpr),
                    y: Math.round((r.y + window.scrollY) * dpr),
                    width: Math.round(r.width * dpr),
                    height: Math.round(r.height * dpr),
                  });
                }
              });
            } catch {
              // invalid selector — the compare side will warn
            }
          }
          return out;
        }, uniqueSelectors);
      }

      const geometricCallMasks = perCallMasks.filter((m) => typeof m !== 'string');
      const callSelectorMasks = perCallMasks.filter((m): m is string => typeof m === 'string');
      if (geometricCallMasks.length > 0 || callSelectorMasks.length > 0 || maskRects.length > 0) {
        await fs.writeJson(path.join(localSnapshotDir, 'metadata.json'), {
          name: snapshotName,
          timestamp: new Date(timestamp).toISOString(),
          ...(geometricCallMasks.length > 0 ? { masks: geometricCallMasks } : {}),
          ...(callSelectorMasks.length > 0 ? { maskSelectors: callSelectorMasks } : {}),
          ...(maskRects.length > 0 ? { maskRects } : {}),
        });
      }
    } catch {
      // metadata is an enhancement; the screenshot path never depends on it
    }

    // Element map: layout + computed-style digest for every visible
    // element, powering attribution ("WHICH element changed"), exact
    // shift classification, and the style fingerprint on the compare
    // side. Best-effort — the screenshot path never depends on it.
    try {
      const mapIgnores = collectIgnoreSelectors(process.cwd(), projectConfig, effectiveConfig);
      const elementMap = await page.evaluate(buildElementMapExpression(undefined, mapIgnores));
      if (Array.isArray(elementMap) && elementMap.length > 0) {
        await fs.writeJson(path.join(localSnapshotDir, 'elements.json'), elementMap);
      }
    } catch {
      // missing elements.json only disables attribution for this capture
    }
  }
}


/**
 * Read the global `mask` list from .testivai/config.json (selector strings
 * and geometric objects). Returns [] when absent or malformed.
 */
function readConfigMasks(projectRoot: string): Array<string | Record<string, number | string>> {
  try {
    const raw = fs.readFileSync(path.join(projectRoot, '.testivai', 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.mask) ? parsed.mask : [];
  } catch {
    return [];
  }
}
