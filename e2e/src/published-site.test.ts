/**
 * OSS E2E — a report published to GitHub Pages, in a real browser.
 *
 *   1. A real report (changed, new and passed snapshots) is zipped the way
 *      the reporter action uploads it.
 *   2. The publish step's code reads the ZIP and builds the site: the run's
 *      page rebuilt from results.json and the PNGs, the index pages, 404.
 *   3. Served over HTTP under /<repo>/ like a project site, every page must
 *      work under its content security policy: no violation, no script
 *      error, every image shown, the report's scripts running (theme toggle,
 *      zoom). The policy must also be enforced: a request to another site
 *      from the page is blocked.
 *
 * Needs a Chrome/Chromium: set TESTIVAI_CHROME_PATH, or have one on PATH.
 * Without one the test is skipped, loudly, except in CI (CI set), where it
 * fails.
 */

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { zipSync } from 'fflate';
import { chromium, type Page } from 'playwright-core';
import { PNG } from 'pngjs';

import { BaselineStore, generateReport } from '@testivai/witness';
import { readReportArchive } from '../../action/src/publish/archive';
import type { PlannedRun, PlanPr, SitePlan } from '../../action/src/publish/plan';
import { buildIndexPages, buildRunReport, type RunOutcome, type SiteFile, type SiteInfo } from '../../action/src/publish/site';

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

function image(width: number, height: number, box: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  for (let y = 20; y < 60; y++) {
    for (let x = 20; x < 140; x++) {
      const i = (y * width + x) * 4;
      [png.data[i], png.data[i + 1], png.data[i + 2]] = box;
    }
  }
  return PNG.sync.write(png);
}

const HTML = '<html><body><main><div class="card">Card</div></main></body></html>';

/** Every file under dir, by path relative to it with '/' separators. */
function readTree(dir: string, prefix = ''): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, readTree(full, rel));
    else out[rel] = new Uint8Array(fs.readFileSync(full));
  }
  return out;
}

/** Serve siteDir under /<repo>/, like GitHub Pages serves a project site, 404.html included. */
function serve(siteDir: string, repo: string): Promise<http.Server> {
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const prefix = `/${repo}/`;
    let file: string | undefined;
    if (url.pathname.startsWith(prefix)) {
      const rel = decodeURIComponent(url.pathname.slice(prefix.length));
      const candidate = path.join(siteDir, rel.endsWith('/') || rel === '' ? `${rel}index.html` : rel);
      if (candidate.startsWith(siteDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) file = candidate;
    }
    const status = file ? 200 : 404;
    const body = fs.readFileSync(file ?? path.join(siteDir, '404.html'));
    res.writeHead(status, { 'content-type': types[path.extname(file ?? '404.html')] ?? 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Records CSP violations and script errors on every page the tab opens. */
async function watch(page: Page): Promise<{ problems: () => Promise<string[]> }> {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`script error: ${err.message}`));
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`));
  });
  return {
    problems: async () => [...errors, ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp))],
  };
}

async function main(): Promise<void> {
  const chrome = findChrome();
  if (!chrome) {
    assert.ok(!process.env.CI, 'CI has no Chrome/Chromium; set TESTIVAI_CHROME_PATH');
    console.log('[e2e] ⚠ SKIPPED published site: no Chrome/Chromium (set TESTIVAI_CHROME_PATH)');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-oss-e2e-site-'));
  let server: http.Server | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // 1. A real report: one changed, one passed, one new snapshot with a name
    //    that is not URL-safe.
    const store = new BaselineStore(root);
    const blue = image(160, 80, [30, 60, 200]);
    const red = image(160, 80, [200, 40, 40]);
    store.writeTemp('home', blue, HTML);
    store.writeTemp('footer', blue, HTML);
    store.approve('home');
    store.approve('footer');
    store.clearTemp();
    store.writeTemp('home', red, HTML);
    store.writeTemp('footer', blue, HTML);
    store.writeTemp('checkout <step 2> #1', blue, HTML);
    const data = generateReport({ projectRoot: root, autoOpen: false });
    assert.deepStrictEqual(
      data.snapshots.map((s) => [s.name, s.status]).sort(),
      [['checkout <step 2> #1', 'new'], ['footer', 'passed'], ['home', 'changed']],
    );

    const reportDir = path.join(root, 'visual-report');
    fs.writeFileSync(path.join(reportDir, 'testivai-run.json'), JSON.stringify({ runId: '1001', runAttempt: 1, sha: 'abc' }));
    const zip = zipSync(Object.fromEntries(Object.entries(readTree(reportDir)).map(([k, v]) => [k, [v, { level: 6 }]])));

    // 2. The site, built the way the publish step builds it.
    const repo = 'testivai-example';
    const site: SiteInfo = { url: `https://testivai.github.io/${repo}/`, repo: `testivai/${repo}`, serverUrl: 'https://github.com', defaultBranch: 'main' };
    const run: PlannedRun = { runId: 1001, attempt: 1, artifactId: 7, sizeBytes: zip.length, dir: 'pr/14/1001-1', headSha: '70d8c8e5a1b2c3d', createdAt: '2026-10-18T10:05:00Z', fork: false };
    const pr: PlanPr = { number: 14, headRepo: `testivai/${repo}`, headRef: 'feature', headSha: run.headSha, author: 'dev', fork: false, title: 'Restyle the hero' };
    const built = buildRunReport({ site, run, pr, artifactUrl: 'https://github.com/testivai/testivai-example/actions/runs/1001/artifacts/7', archive: readReportArchive(zip) });
    assert.ok(built.outcome.ok, `the report could not be shown: ${!built.outcome.ok && built.outcome.reason}`);
    const plan: SitePlan = { prs: [{ pr, runs: [run] }], dropped: [], totalBytes: zip.length };
    const files: SiteFile[] = [...built.files, ...buildIndexPages({ site, plan, outcomes: new Map<number, RunOutcome>([[run.runId, built.outcome]]), runsPerPr: 3 })];

    const siteDir = path.join(root, 'site');
    for (const f of files) {
      const to = path.join(siteDir, f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, f.data);
    }
    const expectedImages = data.snapshots.reduce((n, s) => n + [s.baselinePath, s.currentPath, s.diffPath].filter(Boolean).length, 0);
    // The changed snapshot's thumbnail is published too, for the PR comment; the page does not show it.
    const thumbIndex = data.snapshots.findIndex((s) => s.thumbPath);
    assert.deepStrictEqual(data.snapshots.filter((s) => s.thumbPath).map((s) => s.name), ['home'], 'only the changed snapshot has a thumbnail');
    assert.strictEqual(files.filter((f) => f.path.endsWith('.png')).length, expectedImages + 1, 'every image of the report is published, the thumbnail included');
    assert.ok(files.some((f) => f.path === `pr/14/1001-1/images/${thumbIndex}/thumb.png`), 'the thumbnail is at its numbered path');

    // 3. In a browser.
    server = await serve(siteDir, repo);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${repo}/`;
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage();
    const { problems } = await watch(page);

    // The run's page.
    const response = await page.goto(`${base}pr/14/1001-1/`, { waitUntil: 'load' });
    assert.strictEqual(response?.status(), 200);
    assert.ok(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(), 'the page carries its policy');
    const images = await page.$$eval('.diff-col img', (els) => els.map((el) => ({ src: el.getAttribute('src'), w: (el as HTMLImageElement).naturalWidth })));
    assert.strictEqual(images.length, expectedImages, 'every image is on the page');
    for (const img of images) {
      assert.match(img.src ?? '', /^images\/\d+\/(baseline|current|diff)\.png$/, 'images are under numbered paths');
      assert.ok(img.w > 0, `${img.src} did not load`);
    }
    assert.ok((await page.textContent('body'))?.includes('checkout <step 2> #1'), 'the name is shown as text');
    assert.ok((await page.textContent('main'))?.includes('Pull request #14 · commit 70d8c8e · CI run 1001, attempt 1'));

    await page.click('#themeToggle');
    assert.strictEqual(await page.getAttribute('html', 'data-theme'), 'dark', "the report's own script runs under the policy");
    await page.click('.diff-col img');
    assert.ok(await page.locator('#zoomOverlay.active').count(), 'zoom opens');
    assert.match((await page.getAttribute('#zoomImg', 'src')) ?? '', /images\/\d+\/\w+\.png$/);
    assert.deepStrictEqual(await problems(), [], 'no CSP violation or script error on the run page');
    const thumbSize = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    }, `images/${thumbIndex}/thumb.png`);
    assert.ok(thumbSize[0] > 0 && thumbSize[0] <= 800 && thumbSize[1] > 0 && thumbSize[1] <= 400, `the thumbnail is served and decodes within 800×400 (${thumbSize.join('×')})`);

    // The policy is enforced, not just present.
    const fetched = await page.evaluate(() => fetch('https://example.com/collect').then(() => 'sent', () => 'blocked'));
    assert.strictEqual(fetched, 'blocked');
    assert.ok((await problems()).some((p) => p.startsWith('connect-src blocked https://example.com')), 'the request is reported as a violation');
    console.log('[e2e] ✓ A rebuilt report works under its policy: images, theme, zoom; a request elsewhere is blocked.');

    // The front page links to it.
    const page2 = await browser.newPage();
    const watch2 = await watch(page2);
    await page2.goto(base, { waitUntil: 'load' });
    assert.ok((await page2.textContent('body'))?.includes('Restyle the hero'));
    await Promise.all([page2.waitForURL(`**/${repo}/pr/14/1001-1/`, { timeout: 10_000 }), page2.click('a:text-is("Latest run")')]);
    assert.ok((await page2.textContent('main'))?.includes('CI run 1001, attempt 1'), 'the front page links the run');
    await page2.goto(`${base}pr/14/`, { waitUntil: 'load' });
    assert.ok((await page2.textContent('body'))?.includes('CI run 1001, attempt 1'));
    const gone = await page2.goto(`${base}pr/9/55-1/`, { waitUntil: 'load' });
    assert.strictEqual(gone?.status(), 404);
    assert.ok((await page2.textContent('body'))?.includes('no longer published'));
    assert.deepStrictEqual(await watch2.problems(), [], 'no CSP violation or script error on the index pages');
    console.log('[e2e] ✓ The front page, the pull request page and the 404 page work under their policy.');
  } finally {
    await browser?.close();
    server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[e2e] ✗ Published site E2E failed');
  console.error(err);
  process.exit(1);
});
