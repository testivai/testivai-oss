/**
 * OSS E2E — an unhealthy capture is never "render noise" (real Chrome).
 *
 * The 16 Oct 2026 reproduction, through the Playwright adapter:
 *
 *   1. A page whose stylesheet declares a web font ("Fancy") and applies it
 *      to the body with !important is captured with the font served, and
 *      approved.
 *   2. The same page is captured again with the font's file answering 404:
 *      the browser falls back to monospace. The DOM is identical and the
 *      computed styles match (the style digest hashes the DECLARED
 *      font-family, not the font that rendered), and the diff is a few glyphs
 *      spread over the page: small and scattered.
 *   3. With noiseAutoPass on, that used to auto-pass as likely render noise.
 *      It must stay changed and read "Unhealthy capture", naming the font.
 *
 * And its counterpart: a web font used only by an element that
 * ignoreSelectors hides (collapse) for the whole capture is not in the image,
 * so its 404 must not make the capture unhealthy. The probe runs right after
 * the screenshot, before the hiding style comes off (removing it lays the
 * element out, which starts the font loading).
 *
 * Needs a Chrome/Chromium (TESTIVAI_CHROME_PATH, or one on PATH) and a
 * TrueType font file to serve as "Fancy". Without either the test is
 * skipped, loudly, except in CI (CI set), where it fails.
 */

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright-core';

import { BaselineStore, generateReport, parseHealth, snapshotAnchorId } from '@testivai/witness';
import { witness } from '@testivai/witness-playwright';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'health');

function findChrome(): string | null {
  const fromEnv = process.env.TESTIVAI_CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (process.platform === 'win32') return null;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf-8' }).trim();
      if (found) return found;
    } catch {
      // not on PATH
    }
  }
  return null;
}

/** A serif TrueType font to serve as "Fancy": its glyphs differ from the monospace fallback. */
function findFont(): string | null {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf',
    '/System/Library/Fonts/Supplemental/Georgia.ttf',
    '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
    'C:\\Windows\\Fonts\\georgia.ttf',
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

interface FixtureServer {
  server: http.Server;
  base: string;
  /** Whether /fonts/fancy.ttf answers with the font (true) or 404 (false). */
  fontAvailable: boolean;
}

function serve(fontFile: string): Promise<FixtureServer> {
  const font = fs.readFileSync(fontFile);
  const state = { fontAvailable: true } as FixtureServer;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const send = (status: number, type: string, body: Buffer | string) => {
      // no-store: the second capture must not reuse the first one's font.
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url === '/fancy.html') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(FIXTURES, 'fancy.html')));
    if (url === '/hidden-widget.html') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(FIXTURES, 'hidden-widget.html')));
    if (url === '/css/fancy.css') return send(200, 'text/css; charset=utf-8', fs.readFileSync(path.join(FIXTURES, 'fancy.css')));
    if (url === '/fonts/fancy.ttf' && state.fontAvailable) return send(200, 'font/ttf', font);
    return send(404, 'text/plain', 'not found');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      state.server = server;
      state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve(state);
    }),
  );
}

async function main(): Promise<void> {
  const chrome = findChrome();
  const fontFile = findFont();
  if (!chrome || !fontFile) {
    const missing = !chrome ? 'no Chrome/Chromium (set TESTIVAI_CHROME_PATH)' : 'no TrueType font to serve';
    assert.ok(!process.env.CI, `CI has ${missing}`);
    console.log(`[e2e] ⚠ SKIPPED unhealthy capture: ${missing}`);
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-oss-e2e-health-'));
  fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ noiseAutoPass: true, autoOpen: false }));
  const cwd = process.cwd();
  const fixture = await serve(fontFile);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    // The adapter writes under process.cwd(), like a test run in the project.
    process.chdir(root);
    const store = new BaselineStore(root);
    // A Playwright TestInfo is only read for the project and the file name.
    const testInfo = {} as Parameters<typeof witness>[1];

    // 1. Baseline: the font is served.
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await context.newPage();
      await page.goto(`${fixture.base}/fancy.html`, { waitUntil: 'load' });
      await witness(page as unknown as Parameters<typeof witness>[0], testInfo, 'fancy');
      await context.close();
    }
    store.approve('fancy');
    store.clearTemp();

    // 2. Current: the same page, the font's file answers 404.
    fixture.fontAvailable = false;
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await context.newPage();
      await page.goto(`${fixture.base}/fancy.html`, { waitUntil: 'load' });
      await witness(page as unknown as Parameters<typeof witness>[0], testInfo, 'fancy');
      await context.close();
    }

    // 3. The report.
    const data = generateReport({ projectRoot: root, autoOpen: false });
    const s = data.snapshots.find((x) => x.name === 'fancy');
    assert.ok(s, 'no result for the snapshot');
    console.log(
      `[e2e]   fancy: ${s.status}${s.autoPassed ? ` (auto-passed: ${s.autoPassed})` : ''}, ${s.diffPercent.toFixed(3)}% ` +
        `(${s.diffCount} px, ${s.regions?.length ?? 0} regions), dom ${JSON.stringify(s.dom)}` +
        (s.captureHealth ? `, captureHealth ${JSON.stringify({ unhealthy: s.captureHealth.unhealthy, reasons: s.captureHealth.reasons })}` : ''),
    );

    // The reproduction's conditions: pixels differ a little, the page is the
    // same size, the DOM is identical and the computed styles match.
    assert.ok(s.diffCount > 0, 'the fallback font changed no pixel: the fixture did not reproduce the failure');
    assert.strictEqual(s.sizeMismatch, undefined, 'the fallback font must not change the page size');
    assert.deepStrictEqual(
      s.dom && { changed: s.dom.changed, styleCheck: s.dom.styleCheck },
      { changed: false, styleCheck: 'match' },
      'identical DOM, matching style digests',
    );
    assert.ok(s.diffPercent <= 1, `a small diff (${s.diffPercent}%)`);

    // The defect: it auto-passed as likely render noise.
    assert.strictEqual(s.autoPassed, undefined, `auto-passed as "${s.autoPassed}": an unhealthy capture is never render noise`);
    assert.strictEqual(s.status, 'changed');
    assert.strictEqual(s.dom?.noiseHint, false, 'no noise hint for an unhealthy capture');
    assert.strictEqual(s.captureHealth?.unhealthy, 'candidate');
    assert.ok(
      s.captureHealth?.reasons.some((r) => r.includes("web font 'Fancy' failed to load")),
      `the reasons name the font: ${JSON.stringify(s.captureHealth?.reasons)}`,
    );
    // The baseline was healthy, and its health was frozen on approve.
    assert.deepStrictEqual(store.readMetadata('fancy')?.health?.fonts, { status: 'loaded', failed: [] }, 'the healthy baseline');

    const html = fs.readFileSync(path.join(root, 'visual-report', 'index.html'), 'utf-8');
    const start = html.indexOf(`<div class="snapshot" id="${snapshotAnchorId('fancy')}">`);
    assert.notStrictEqual(start, -1, 'no card for the snapshot in the report');
    const card = html.slice(start);
    assert.match(card, /Unhealthy capture/);
    assert.doesNotMatch(card, /Likely render noise/);
    console.log('[e2e] ✓ A web font that failed to load reads as an unhealthy capture, never as render noise, and is not auto-passed.');

    // 4. A web font only a hidden element uses: not in the image, so not unhealthy.
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await context.newPage();
      await page.goto(`${fixture.base}/hidden-widget.html`, { waitUntil: 'load' });
      assert.strictEqual(await page.evaluate('performance.getEntriesByName(new URL("/fonts/gone.ttf", location.href).href).length'), 0, 'the font must not be requested before the capture');
      await witness(page as unknown as Parameters<typeof witness>[0], testInfo, 'hidden-widget', {
        ignoreSelectors: [{ selector: '#widget', mode: 'collapse' }],
      });
      // The widget is laid out once the ignore rule comes off: its font is
      // requested then and fails, after the capture.
      await page.waitForFunction('document.fonts.status === "loaded" && performance.getEntriesByType("resource").some(function (e) { return /gone\\.ttf$/.test(e.name); })');
      await context.close();
    }
    const hidden = parseHealth(store.readTempMetadata('hidden-widget')?.health);
    assert.ok(hidden, 'no health recorded for the hidden-widget capture');
    assert.deepStrictEqual(
      { fonts: hidden.fonts, resources: hidden.resources },
      { fonts: { status: 'loaded', failed: [] }, resources: { status: 'checked', failed: {} } },
      'a font only a hidden element uses is not in the image: the capture is healthy',
    );
    console.log('[e2e] ✓ A web font only an element hidden by ignoreSelectors uses does not make the capture unhealthy.');
  } finally {
    process.chdir(cwd);
    await browser.close();
    fixture.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[e2e] ✗ Unhealthy capture E2E failed');
  console.error(err);
  process.exit(1);
});
