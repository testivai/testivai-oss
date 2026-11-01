/**
 * OSS E2E — device emulation around the default full-page capture (real
 * Chrome, the Playwright adapter).
 *
 * Chrome's beyond-viewport capture, over the adapter's own CDP session,
 * dropped the page's device emulation for the rest of the test: on Pixel 7,
 * devicePixelRatio 2.625 → 1 and touch off. For each Chromium profile with a
 * pixel ratio above 1 (Pixel 7, Desktop Chrome HiDPI) and one at 1:
 *
 *   1. After witness(), the page's pixel ratio, touch points and
 *      `pointer: coarse` are what they were before, twice in a row.
 *   2. metadata.json records the scale the image was rendered at (its width
 *      over the viewport's), and the element map is on that same scale.
 *
 * Needs a Chrome/Chromium (TESTIVAI_CHROME_PATH, or one on PATH). Without one
 * the test is skipped, loudly, except in CI (CI set), where it fails.
 */

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, devices } from 'playwright-core';
import { PNG } from 'pngjs';

import { witness } from '@testivai/witness-playwright';

const PAGE = `<!doctype html><meta name="viewport" content="width=device-width">
<style>body{margin:0} #box{width:200px;height:100px;background:#1565c0} .tall{height:1500px}</style>
<div id="box"></div><div class="tall"></div>`;

const STATE = `({ dpr: devicePixelRatio, touch: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches, width: innerWidth })`;

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

async function main(): Promise<void> {
  const chrome = findChrome();
  if (!chrome) {
    assert.ok(!process.env.CI, 'CI has no Chrome/Chromium (set TESTIVAI_CHROME_PATH)');
    console.log('[e2e] ⚠ SKIPPED capture emulation: no Chrome/Chromium (set TESTIVAI_CHROME_PATH)');
    return;
  }
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const cwd = process.cwd();
  try {
    for (const profile of ['Pixel 7', 'Desktop Chrome HiDPI', 'Desktop Chrome'] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-oss-e2e-emulation-'));
      fs.mkdirSync(path.join(root, '.testivai'));
      fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ autoOpen: false }));
      process.chdir(root);
      try {
        const context = await browser.newContext({ ...devices[profile] });
        const page = await context.newPage();
        await page.setContent(PAGE);
        const before = await page.evaluate(STATE);
        for (const name of ['first', 'second']) {
          await witness(page as unknown as Parameters<typeof witness>[0], {} as Parameters<typeof witness>[1], name);
          const after = await page.evaluate(STATE);
          assert.deepStrictEqual(after, before, `${profile}, ${name} capture: the page's emulation changed`);

          const dir = path.join(root, '.testivai', 'temp', name);
          const png = PNG.sync.read(fs.readFileSync(path.join(dir, 'screenshot.png')));
          const scale = png.width / before.width;
          const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf-8'));
          assert.strictEqual(meta.environment.render.deviceScaleFactor, scale, `${profile}: metadata says ${meta.environment.render.deviceScaleFactor} for a ${scale}× image`);
          const box = JSON.parse(fs.readFileSync(path.join(dir, 'elements.json'), 'utf-8')).find((e: { path: string }) => e.path === 'body > div:nth-of-type(1)');
          assert.strictEqual(box?.width, Math.round(200 * scale), `${profile}: the element map is not on the image's scale`);
        }
        console.log(`[e2e] ✓ ${profile}: emulation unchanged after two captures ${JSON.stringify(before)}; images at ${PNG.sync.read(fs.readFileSync(path.join(root, '.testivai', 'temp', 'first', 'screenshot.png'))).width / before.width}×, recorded as such.`);
        await context.close();
      } finally {
        process.chdir(cwd);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[e2e] ✗ capture emulation E2E failed');
  console.error(err);
  process.exit(1);
});
