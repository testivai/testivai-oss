/**
 * OSS E2E — a React Native screen rendered by react-native-web, captured by
 * the Playwright adapter on the Pixel 7 profile (real Chrome).
 *
 * The fixture (fixtures/rn-web/App.jsx) is real React Native code: View,
 * Text, Pressable and StyleSheet with testID props, bundled with esbuild and
 * `react-native` aliased to react-native-web 0.21.4 (the version Expo SDK 58
 * pins). Each scenario approves a baseline of the plain screen, captures a
 * scripted change, and reads results.json:
 *
 *   1. No change, three times: passed, zero pixels.
 *   2. The button's StyleSheet colour: react-native-web swaps an atomic class,
 *      so the DOM diff counts an attribute change; with volatileAttributes
 *      ["class"] it reads style-only, attributed to the button by testID.
 *   3. The title's text: one text change, attributed to the header.
 *   4. A banner inserted at the top: default paths never find the move (the
 *      banner renumbers the :nth-of-type paths, and cards that look alike are
 *      paired with their neighbours, so some regions read a shift by a wrong
 *      distance); with elementIdAttributes ["data-testid"] the moved content
 *      reads as "shift" by the banner's height and the page shift is found.
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
import { build } from 'esbuild';
import { chromium, devices } from 'playwright-core';
import { PNG } from 'pngjs';

import { BaselineStore, generateReport } from '@testivai/witness';
import { witness } from '@testivai/witness-playwright';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'rn-web');
const PIXEL_7 = devices['Pixel 7'];
/** The banner's 56 px plus its 8 px margin, in CSS px. */
const BANNER_CSS = 64;

type Snapshot = ReturnType<typeof generateReport>['snapshots'][number];
type Browser = Awaited<ReturnType<typeof chromium.launch>>;

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

/** Bundle the RN screen for the browser: react-native → react-native-web. */
async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [path.join(FIXTURE, 'App.jsx')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    alias: { 'react-native': 'react-native-web' },
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

/** Two fixed routes; no path is built from the request. */
function serve(js: string): Promise<{ server: http.Server; base: string }> {
  const html = fs.readFileSync(path.join(FIXTURE, 'index.html'));
  const server = http.createServer((req, res) => {
    const route = (req.url ?? '').split('?')[0];
    if (route === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } else if (route === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(js);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })),
  );
}

/**
 * Approve a capture of the plain screen, then capture each variant and
 * compare it. Returns one result per variant, in order.
 */
async function scenario(browser: Browser, base: string, config: object, variants: string[]): Promise<Snapshot[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-oss-e2e-rnw-'));
  fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ autoOpen: false, ...config }));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const store = new BaselineStore(root);
    const testInfo = {} as Parameters<typeof witness>[1];
    const capture = async (query: string) => {
      const context = await browser.newContext({ ...PIXEL_7 });
      const page = await context.newPage();
      await page.goto(`${base}/${query}`, { waitUntil: 'load' });
      await page.getByTestId('track-order').waitFor();
      await witness(page as unknown as Parameters<typeof witness>[0], testInfo, 'orders');
      await context.close();
    };
    await capture('');
    store.approve('orders');
    // The image's own scale: on Chromium the adapter captures at 1× CSS px
    // (docs/guides/mobile-web.md, "Known limits"), elsewhere at the DPR.
    const width = PNG.sync.read(fs.readFileSync(path.join(root, '.testivai', 'baselines', 'orders', 'screenshot.png'))).width;
    captureScale = width / PIXEL_7.viewport.width;
    const out: Snapshot[] = [];
    for (const variant of variants) {
      store.clearTemp();
      await capture(variant ? `?${variant}` : '');
      const s = generateReport({ projectRoot: root, autoOpen: false }).snapshots.find((x) => x.name === 'orders');
      assert.ok(s, `no result for ${variant || 'the plain screen'}`);
      out.push(s);
    }
    return out;
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function describe(label: string, s: Snapshot): void {
  const regions = (s.regions ?? []) as Array<{ classification?: string; shift?: object; elements?: Array<{ selector: string }> }>;
  console.log(
    `[e2e]   ${label}: ${s.status} ${s.diffPercent.toFixed(3)}%, dom ${JSON.stringify(s.dom)}, ` +
      `pageShift ${JSON.stringify(s.pageShift ?? null)}`,
  );
  for (const r of regions) console.log(`[e2e]     ${r.classification} ${JSON.stringify(r.shift ?? null)} ${r.elements?.[0]?.selector ?? ''}`);
}

/** Set by scenario() from the approved image: device px per CSS px. */
let captureScale = 0;

const ANCHORED = { elementIdAttributes: ['data-testid'], volatileAttributes: ['class'] };

async function main(): Promise<void> {
  const chrome = findChrome();
  if (!chrome) {
    assert.ok(!process.env.CI, 'CI has no Chrome/Chromium (set TESTIVAI_CHROME_PATH)');
    console.log('[e2e] ⚠ SKIPPED react-native-web: no Chrome/Chromium (set TESTIVAI_CHROME_PATH)');
    return;
  }
  const { server, base } = await serve(await bundle());
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    // The fixture really is react-native-web output.
    {
      const context = await browser.newContext({ ...PIXEL_7 });
      const page = await context.newPage();
      await page.goto(`${base}/`, { waitUntil: 'load' });
      const button = page.getByTestId('track-order');
      await button.waitFor();
      const cls = (await button.getAttribute('class')) ?? '';
      assert.match(cls, /\bcss-[a-z0-9]+\b/, `not react-native-web output: class "${cls}"`);
      assert.match(cls, /\br-[a-zA-Z0-9]+\b/, `no atomic r-* classes from StyleSheet: "${cls}"`);
      await context.close();
    }

    // 1. No change, three runs.
    const same = await scenario(browser, base, ANCHORED, ['', '', '']);
    same.forEach((s, i) => {
      describe(`no change, run ${i + 1}`, s);
    });
    for (const s of same) {
      assert.strictEqual(s.status, 'passed', 'the same screen did not pass');
      assert.strictEqual(s.diffPercent, 0, 'the same screen differed');
    }
    console.log('[e2e] ✓ react-native-web, no change: passed with zero pixels, three runs in a row.');

    // 2. StyleSheet colour: react-native-web swaps an atomic class.
    const [plainRecolor] = await scenario(browser, base, { elementIdAttributes: ['data-testid'] }, ['recolor']);
    describe('recolor, default volatileAttributes', plainRecolor);
    assert.strictEqual(plainRecolor.status, 'changed');
    assert.strictEqual(plainRecolor.dom?.changed, true, 'a StyleSheet change swaps a class: an attribute change without volatileAttributes');
    assert.ok((plainRecolor.dom?.summary?.attributeChanges ?? 0) >= 1, 'expected attribute changes');

    const [recolor] = await scenario(browser, base, ANCHORED, ['recolor']);
    describe('recolor, volatileAttributes ["class"]', recolor);
    assert.strictEqual(recolor.status, 'changed');
    assert.strictEqual(recolor.dom?.changed, false, 'with volatileAttributes ["class"] the DOM must read unchanged');
    assert.strictEqual(recolor.dom?.styleCheck, 'mismatch', 'the style check must catch the colour');
    assert.strictEqual(recolor.dom?.noiseHint, false);
    assert.ok(
      recolor.dom?.styleChanges?.elements.includes('div[data-testid="track-order"]'),
      `the style change is not attributed to the button: ${JSON.stringify(recolor.dom?.styleChanges)}`,
    );
    const recolorRegions = (recolor.regions ?? []) as Array<{ elements?: Array<{ selector: string }> }>;
    assert.ok(recolorRegions.length > 0, 'no change region');
    assert.ok(
      recolorRegions.every((r) => (r.elements?.[0]?.selector ?? '').startsWith('div[data-testid="track-order"]')),
      'every region should be on the button',
    );
    console.log('[e2e] ✓ react-native-web, StyleSheet colour: an attribute change by default; style-only on div[data-testid="track-order"] with volatileAttributes ["class"].');

    // 3. Text.
    const [retitle] = await scenario(browser, base, ANCHORED, ['retitle']);
    describe('retitle', retitle);
    assert.strictEqual(retitle.status, 'changed');
    assert.strictEqual(retitle.dom?.changed, true);
    assert.strictEqual(retitle.dom?.summary?.textChanges, 1, 'one text change');
    assert.strictEqual(retitle.dom?.summary?.attributeChanges, 0, 'no attribute change for a text edit');
    const retitleRegions = (retitle.regions ?? []) as Array<{ elements?: Array<{ selector: string }> }>;
    assert.ok(
      retitleRegions.some((r) => (r.elements?.[0]?.selector ?? '').startsWith('div[data-testid="header"]')),
      'the text change is not attributed to the header',
    );
    console.log('[e2e] ✓ react-native-web, title text: one text change, attributed to div[data-testid="header"].');

    // 4. Banner inserted at the top.
    const BANNER_DY = Math.round(BANNER_CSS * captureScale);
    assert.ok(BANNER_DY > 0, 'no capture scale');
    const [bannerOff] = await scenario(browser, base, {}, ['banner']);
    describe('banner, default paths', bannerOff);
    const offRegions = (bannerOff.regions ?? []) as Array<{ classification?: string; shift?: { dx: number; dy: number } }>;
    assert.ok(offRegions.length > 0);
    // The banner renumbers every :nth-of-type below it, so the true move is
    // never found. Worse, sibling cards that look alike get paired with their
    // neighbours: some regions read as a "shift" by a wrong distance, and a
    // wrong page shift can be reported. Pinned here as it is today.
    assert.ok(
      offRegions.every((r) => r.classification === 'change' || r.shift?.dy !== BANNER_DY),
      'default paths found the true shift; the anchored paths would no longer be needed',
    );
    assert.notStrictEqual(bannerOff.pageShift?.dy, BANNER_DY, 'default paths found the true page shift');
    const wrongShifts = offRegions.filter((r) => r.classification === 'shift').length;

    const [bannerOn] = await scenario(browser, base, ANCHORED, ['banner']);
    describe('banner, elementIdAttributes', bannerOn);
    const onRegions = (bannerOn.regions ?? []) as Array<{ classification?: string; shift?: { dx: number; dy: number }; elements?: Array<{ selector: string }> }>;
    const shifts = onRegions.filter((r) => r.classification === 'shift');
    assert.ok(shifts.length > 0, 'elementIdAttributes: no region reads "shift"');
    for (const r of shifts) assert.deepStrictEqual(r.shift, { dx: 0, dy: BANNER_DY }, 'a shift by the banner height');
    for (const r of onRegions.filter((x) => x.classification !== 'shift')) {
      assert.match(r.elements?.[0]?.selector ?? '', /daily-banner/, `a "change" region that is not the banner: ${JSON.stringify(r)}`);
    }
    assert.strictEqual(bannerOn.pageShift?.dy, BANNER_DY, 'the page shift by the banner height');
    console.log(
      `[e2e] ✓ react-native-web, banner at the top: default paths never find the ${BANNER_DY}px move ` +
        `(${wrongShifts} region(s) read a wrong shift, page shift ${JSON.stringify(bannerOff.pageShift?.dy ?? null)}); with elementIdAttributes ` +
        `${shifts.length} of ${onRegions.length} regions shift by ${BANNER_DY}px and the page shift is found.`,
    );
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('[e2e] ✗ react-native-web E2E failed');
  console.error(err);
  process.exit(1);
});
