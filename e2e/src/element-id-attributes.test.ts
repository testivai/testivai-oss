/**
 * OSS E2E — elementIdAttributes in real Chrome.
 *
 * 1. Default output is byte-identical. The collector as it was before the
 *    option (fixtures/element-paths/collector-before.js, frozen) and the
 *    current one run in the same pages; with the option unset (and set to
 *    []) the maps must serialise to the same bytes. The same holds for the
 *    elements.json the Playwright adapter writes, and its metadata.json gets
 *    no elementIdAttributes key.
 * 2. Anchored paths are real selectors: on every fixture page, with
 *    elementIdAttributes ["data-testid"], each anchored path matches exactly
 *    the element it was collected from (document.querySelectorAll), values
 *    that need escaping included.
 * 3. The banner case (Trifoldie): a "Daily challenge" banner inserted above
 *    a react-native-web shaped page. Captured with the Playwright adapter and
 *    compared: with the option off the moved elements read as "change" (the
 *    banner renumbers their :nth-of-type paths); with ["data-testid"] they
 *    read as "shift" by the banner's height, and the page shift is detected.
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
import { chromium, type Page } from 'playwright-core';

import { BaselineStore, buildElementMapExpression, generateReport } from '@testivai/witness';
import { witness } from '@testivai/witness-playwright';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'element-paths');
const BEFORE = fs.readFileSync(path.join(FIXTURES, 'collector-before.js'), 'utf-8');
const PAGES = ['/mixed.html', '/rnw.html', '/rnw.html?banner', '/escape.html'];
/** The banner's height plus its margin, in CSS px (DPR 1). */
const BANNER_DY = 68;

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

function serve(): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req, res) => {
    const file = (req.url ?? '').split('?')[0].replace(/^\//, '');
    if (!/^[a-z-]+\.html$/.test(file) || !fs.existsSync(path.join(FIXTURES, file))) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(path.join(FIXTURES, file)));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })),
  );
}

/** The frozen collector, called the way every adapter called it before the option. */
const beforeExpression = (ignore: string[]) => `(${BEFORE.slice(BEFORE.indexOf('function collectElementMap'))})(document, window, 3000, ${JSON.stringify(ignore)})`;

async function defaultIsByteIdentical(page: Page, base: string): Promise<void> {
  for (const url of PAGES) {
    await page.goto(base + url, { waitUntil: 'load' });
    for (const ignore of [[], ['.ad', '#nope']]) {
      const before = JSON.stringify(await page.evaluate(beforeExpression(ignore)));
      const unset = JSON.stringify(await page.evaluate(buildElementMapExpression(3000, ignore)));
      const empty = JSON.stringify(await page.evaluate(buildElementMapExpression(3000, ignore, [])));
      assert.ok(JSON.parse(before).length > 3, `${url}: the fixture produced a map`);
      assert.strictEqual(unset, before, `${url} ${JSON.stringify(ignore)}: default output drifted from the collector before the option`);
      assert.strictEqual(empty, before, `${url} ${JSON.stringify(ignore)}: [] must equal unset`);
      // And the option does change these pages (the comparison is not vacuous).
      const anchored = JSON.stringify(await page.evaluate(buildElementMapExpression(3000, ignore, ['data-testid'])));
      assert.notStrictEqual(anchored, before, `${url}: data-testid anchors changed nothing; the fixture does not exercise them`);
    }
  }
  console.log(`[e2e] ✓ Default element maps are byte-identical to the collector before the option (${PAGES.length} pages × 2 ignore lists).`);
}

async function anchoredPathsAreSelectors(page: Page, base: string): Promise<void> {
  let anchoredCount = 0;
  for (const url of PAGES) {
    await page.goto(base + url, { waitUntil: 'load' });
    const map = (await page.evaluate(buildElementMapExpression(3000, [], ['data-testid', 'data-test']))) as Array<{
      path: string; x: number; y: number; width: number; height: number;
    }>;
    assert.strictEqual(new Set(map.map((e) => e.path)).size, map.length, `${url}: paths are not unique`);
    for (const entry of map) {
      if (!/^[a-z0-9]+\[data-test(id)?="/.test(entry.path)) continue;
      anchoredCount++;
      const found = await page.evaluate((selector: string) => {
        const all = document.querySelectorAll(selector);
        if (all.length !== 1) return { count: all.length };
        const r = all[0].getBoundingClientRect();
        return { count: 1, x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) };
      }, entry.path);
      assert.deepStrictEqual(
        found,
        { count: 1, x: entry.x, y: entry.y, width: entry.width, height: entry.height },
        `${url}: ${JSON.stringify(entry.path)} does not select exactly the element it came from`,
      );
    }
  }
  assert.ok(anchoredCount >= 30, `only ${anchoredCount} anchored paths checked`);
  console.log(`[e2e] ✓ ${anchoredCount} anchored paths each select exactly their element (escaping included).`);
}

interface Outcome {
  regions: Array<{ classification?: string; shift?: { dx: number; dy: number }; elements?: Array<{ selector: string; role: string }> }>;
  pageShift?: { dy: number; count: number };
  styleCheck?: string;
}

async function bannerCase(browser: Awaited<ReturnType<typeof chromium.launch>>, base: string, ids: string[] | null): Promise<Outcome> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-oss-e2e-ids-'));
  fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.testivai', 'config.json'),
    JSON.stringify({ autoOpen: false, ...(ids ? { elementIdAttributes: ids } : {}) }),
  );
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const store = new BaselineStore(root);
    const testInfo = {} as Parameters<typeof witness>[1];
    const capture = async (url: string) => {
      const context = await browser.newContext({ viewport: { width: 400, height: 900 } });
      const page = await context.newPage();
      await page.goto(base + url, { waitUntil: 'load' });
      await witness(page as unknown as Parameters<typeof witness>[0], testInfo, 'board');
      if (!ids) {
        // The adapter's own elements.json, unset: the same as the collector before the option.
        const before = await page.evaluate(beforeExpression([]));
        const written = JSON.parse(fs.readFileSync(path.join(root, '.testivai', 'temp', 'board', 'elements.json'), 'utf-8'));
        assert.deepStrictEqual(written, before, 'the adapter wrote a different default element map');
        const meta = store.readTempMetadata('board') ?? {};
        assert.ok(!('elementIdAttributes' in meta), 'metadata.json got an elementIdAttributes key while unset');
      }
      await context.close();
    };
    await capture('/rnw.html');
    store.approve('board');
    store.clearTemp();
    await capture('/rnw.html?banner');
    const data = generateReport({ projectRoot: root, autoOpen: false });
    const s = data.snapshots.find((x) => x.name === 'board');
    assert.ok(s, 'no result for the snapshot');
    assert.strictEqual(s.status, 'changed', 'the banner changed nothing');
    return { regions: (s.regions ?? []) as Outcome['regions'], pageShift: s.pageShift, styleCheck: s.dom?.styleCheck };
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function describeOutcome(label: string, o: Outcome): void {
  console.log(`[e2e]   ${label}: ${o.regions.length} regions, ${JSON.stringify(o.regions.map((r) => r.classification))}, pageShift ${JSON.stringify(o.pageShift)}, styleCheck ${o.styleCheck}`);
  for (const r of o.regions) console.log(`[e2e]     ${r.classification} ${JSON.stringify(r.shift ?? null)} ${r.elements?.[0]?.selector ?? ''}`);
}

async function main(): Promise<void> {
  const chrome = findChrome();
  if (!chrome) {
    assert.ok(!process.env.CI, 'CI has no Chrome/Chromium (set TESTIVAI_CHROME_PATH)');
    console.log('[e2e] ⚠ SKIPPED elementIdAttributes: no Chrome/Chromium (set TESTIVAI_CHROME_PATH)');
    return;
  }
  const { server, base } = await serve();
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 400, height: 900 } })).newPage();
    await defaultIsByteIdentical(page, base);
    await anchoredPathsAreSelectors(page, base);

    const off = await bannerCase(browser, base, null);
    describeOutcome('option off', off);
    assert.ok(off.regions.length > 0, 'option off: no regions');
    assert.ok(off.regions.every((r) => r.classification === 'change'), 'option off: expected every region to read "change" (the reported bug)');
    assert.strictEqual(off.pageShift, undefined, 'option off: no page shift can be found');
    // Renumbered paths pair up different elements, so their styles differ.
    assert.strictEqual(off.styleCheck, 'mismatch', 'option off: the style check pairs different elements');
    console.log('[e2e] ✓ Banner above the content, option off: every region reads "change", no page shift.');

    const on = await bannerCase(browser, base, ['data-testid']);
    describeOutcome('option on', on);
    const shifts = on.regions.filter((r) => r.classification === 'shift');
    assert.ok(shifts.length > 0, 'option on: no region reads "shift"');
    for (const r of shifts) assert.deepStrictEqual(r.shift, { dx: 0, dy: BANNER_DY }, 'a shift by the banner height');
    // Every region not explained by the moved content is the banner itself.
    for (const r of on.regions.filter((x) => x.classification !== 'shift')) {
      assert.match(r.elements?.[0]?.selector ?? '', /daily-banner/, `option on: a "change" region that is not the banner: ${JSON.stringify(r)}`);
    }
    assert.deepStrictEqual(on.pageShift && { dy: on.pageShift.dy }, { dy: BANNER_DY }, 'option on: the page shift by the banner height');
    assert.strictEqual(on.styleCheck, 'match', 'option on: the same elements are paired, and their styles match');
    console.log(
      `[e2e] ✓ Banner above the content, option on: ${shifts.length} of ${on.regions.length} regions read "shift" by ${BANNER_DY}px ` +
        `(any other region is the banner), page shift over ${on.pageShift?.count} elements, styles match.`,
    );
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('[e2e] ✗ elementIdAttributes E2E failed');
  console.error(err);
  process.exit(1);
});
