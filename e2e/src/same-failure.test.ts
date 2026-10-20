/**
 * OSS E2E — the same broken asset on both sides keeps the pass tolerances
 * (real Chrome).
 *
 * A site whose web font answers 404 on every run (a third-party font a CI
 * runner cannot reach) makes every capture unhealthy. When the baseline was
 * approved with that same failure, both images miss the same font, so the
 * diff compares like with like: maxDiffPercent / maxDiffPixels /
 * shiftTolerance still apply (captureHealth.sameOnBothSides), noiseAutoPass
 * never does, and a different failure keeps every tolerance off.
 *
 *   1. Baseline: the page with its font 404ing and a 4×4 dot drawn black.
 *   2. Current: the same page, the same 404, the dot drawn dark grey. The DOM
 *      is identical and the styles match (the dot's colour comes from a
 *      script file); 16 pixels differ, the shape render noise takes.
 *      With maxDiffPercent 0.5 it passes as 'threshold'; with noiseAutoPass
 *      alone it stays changed.
 *   3. Current with the font at another URL (also 404): the failures differ,
 *      so maxDiffPercent 0.5 does not pass it.
 *
 * Needs a Chrome/Chromium (TESTIVAI_CHROME_PATH, or one on PATH). Without one
 * the test is skipped, loudly, except in CI (CI set), where it fails.
 */

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright-core';

import { BaselineStore, generateReport, snapshotAnchorId } from '@testivai/witness';
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

interface FixtureServer {
  server: http.Server;
  base: string;
  /** The web font's path: never served, so it always answers 404. */
  fontPath: string;
  /** The dot's colour, drawn by /js/dot.js. */
  dot: string;
}

function serve(): Promise<FixtureServer> {
  const state = { fontPath: '/fonts/brand.ttf', dot: '#000000' } as FixtureServer;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const send = (status: number, type: string, body: Buffer | string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url === '/same-failure.html') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(FIXTURES, 'same-failure.html')));
    if (url === '/css/same-failure.css') {
      return send(
        200,
        'text/css; charset=utf-8',
        `@font-face { font-family: "Brand"; src: url("${state.fontPath}") format("truetype"); }
html, body { margin: 0; background: #fff; color: #222; }
body { font-family: "Brand", monospace !important; }
.word { position: absolute; width: 72px; height: 20px; overflow: hidden; font-size: 12px; line-height: 20px; white-space: nowrap; }
.w1 { top: 16px; left: 16px; }
.w2 { top: 340px; left: 600px; }
#dot { position: absolute; top: 600px; left: 900px; width: 4px; height: 4px; }`,
      );
    }
    if (url === '/js/dot.js') {
      return send(200, 'text/javascript', `var c = document.getElementById('dot').getContext('2d'); c.fillStyle = '${state.dot}'; c.fillRect(0, 0, 4, 4);`);
    }
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
  if (!chrome) {
    assert.ok(!process.env.CI, 'CI has no Chrome/Chromium (set TESTIVAI_CHROME_PATH)');
    console.log('[e2e] ⚠ SKIPPED same failure on both sides: no Chrome/Chromium (set TESTIVAI_CHROME_PATH)');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-oss-e2e-same-failure-'));
  fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ autoOpen: false }));
  const cwd = process.cwd();
  const fixture = await serve();
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    // The adapter writes under process.cwd(), like a test run in the project.
    process.chdir(root);
    const store = new BaselineStore(root);
    // A Playwright TestInfo is only read for the project and the file name.
    const testInfo = {} as Parameters<typeof witness>[1];
    const capture = async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await context.newPage();
      await page.goto(`${fixture.base}/same-failure.html`, { waitUntil: 'load' });
      await witness(page as unknown as Parameters<typeof witness>[0], testInfo, 'broken-font');
      await context.close();
    };
    const report = (passCriteria: Parameters<typeof generateReport>[0]['passCriteria']) => {
      const data = generateReport({ projectRoot: root, autoOpen: false, passCriteria });
      const s = data.snapshots.find((x) => x.name === 'broken-font');
      assert.ok(s, 'no result for the snapshot');
      console.log(
        `[e2e]   broken-font ${JSON.stringify(passCriteria)}: ${s.status}${s.autoPassed ? ` (auto-passed: ${s.autoPassed})` : ''}, ` +
          `${s.diffPercent.toFixed(4)}% (${s.diffCount} px), dom ${JSON.stringify(s.dom)}, ` +
          `captureHealth ${JSON.stringify({ unhealthy: s.captureHealth?.unhealthy, sameOnBothSides: s.captureHealth?.sameOnBothSides })}`,
      );
      return s;
    };

    // 1. Baseline, approved with the font 404ing.
    await capture();
    store.approve('broken-font');
    store.clearTemp();
    const baselineFonts = store.readMetadata('broken-font')?.health?.fonts;
    assert.deepStrictEqual(baselineFonts?.failed, [{ family: 'Brand', weight: 'normal', style: 'normal' }], 'the baseline recorded the failed font');

    // 2. The same failure, the dot redrawn.
    fixture.dot = '#202020';
    await capture();
    const within = report({ maxDiffPercent: 0.5 });
    // The conditions: pixels differ a little, the same size, an identical DOM with matching styles.
    assert.ok(within.diffCount > 0, 'the dot changed no pixel: the fixture did not reproduce a diff');
    assert.ok(within.diffPercent <= 0.5, `a small diff (${within.diffPercent}%)`);
    assert.strictEqual(within.sizeMismatch, undefined);
    assert.deepStrictEqual(within.dom && { changed: within.dom.changed, styleCheck: within.dom.styleCheck }, { changed: false, styleCheck: 'match' });
    // Both unhealthy, the same way: the tolerance applies, never as noise.
    assert.strictEqual(within.captureHealth?.unhealthy, 'both');
    assert.strictEqual(within.captureHealth?.sameOnBothSides, true, 'the same failure on both sides');
    assert.strictEqual(within.dom?.noiseHint, false, 'an unhealthy capture is never a noise hint');
    assert.strictEqual(within.status, 'passed', 'maxDiffPercent still applies when both sides failed the same way');
    assert.strictEqual(within.autoPassed, 'threshold');

    const html = fs.readFileSync(path.join(root, 'visual-report', 'index.html'), 'utf-8');
    const start = html.indexOf(`<div class="snapshot" id="${snapshotAnchorId('broken-font')}">`);
    assert.notStrictEqual(start, -1, 'no card for the snapshot in the report');
    const card = html.slice(start);
    assert.match(card, /Unhealthy capture/);
    assert.match(card, /the baseline was captured with the same failures/);
    assert.match(card, /auto-passed by the &#039;threshold&#039; criterion/);
    assert.doesNotMatch(card, /Likely render noise/);
    console.log('[e2e] ✓ The same broken font on both sides: maxDiffPercent still applies, worded as an unhealthy capture.');

    // noiseAutoPass alone never passes an unhealthy capture.
    const noiseOnly = report({ noiseAutoPass: true, noiseMaxDiffPercent: 5 });
    assert.strictEqual(noiseOnly.captureHealth?.sameOnBothSides, true);
    assert.strictEqual(noiseOnly.status, 'changed', 'noiseAutoPass must never pass an unhealthy capture');
    assert.strictEqual(noiseOnly.autoPassed, undefined);
    console.log('[e2e] ✓ The same broken font on both sides: noiseAutoPass alone does not pass it.');

    // 3. A different failure: the font at another URL, also 404.
    store.clearTemp();
    fixture.fontPath = '/fonts/brand-v2.ttf';
    await capture();
    const different = report({ maxDiffPercent: 0.5 });
    assert.ok(different.diffCount > 0 && different.diffPercent <= 0.5, `the same small diff (${different.diffPercent}%)`);
    assert.strictEqual(different.captureHealth?.unhealthy, 'both');
    assert.strictEqual(different.captureHealth?.sameOnBothSides, undefined, 'a different failed font URL is not the same failure');
    assert.strictEqual(different.status, 'changed', 'no tolerance applies when the two sides failed differently');
    assert.strictEqual(different.autoPassed, undefined);
    console.log('[e2e] ✓ A different broken asset on each side: no tolerance applies.');
  } finally {
    process.chdir(cwd);
    await browser.close();
    fixture.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[e2e] ✗ Same failure on both sides E2E failed');
  console.error(err);
  process.exit(1);
});
