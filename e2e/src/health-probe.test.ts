/**
 * OSS E2E — the capture-health probe in real Chrome.
 *
 * One fixture page per case, served over HTTP:
 *   (a) a @font-face whose file answers 404,
 *   (b) a <link rel=stylesheet> that answers 404 (its query string carries a
 *       "token" that must never be recorded),
 *   (c) a broken <img>,
 *   (d) a healthy page (a web font, a stylesheet and an image that all load),
 *   (e) a web font whose first source answers 404 and whose next one loads
 *       (the face renders as built: a warning, not unhealthy),
 *   (f) a <link rel=preload as=image> of an extensionless URL that answers
 *       404 (not a stylesheet),
 *   (g) a script request for a .css file that answers 404 (not a stylesheet
 *       the page applied).
 *
 * 1. HEALTH_PROBE_EXPRESSION evaluated in each page (Playwright) must parse
 *    to exactly the expected health.
 * 2. `testivai witness <url>` (the standalone crawler: probe plus network
 *    evidence) must record the same health in each capture's metadata.json,
 *    and results.json must call the font and stylesheet pages unhealthy
 *    captures, and the broken image and (e) to (g) warnings.
 *
 * Needs a Chrome/Chromium (TESTIVAI_CHROME_PATH, or one on PATH) and a
 * TrueType font file to serve. Without either the test is skipped, loudly,
 * except in CI (CI set), where it fails.
 */

import * as assert from 'assert';
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

import { type CaptureHealth, HEALTH_PROBE_EXPRESSION, parseHealth } from '@testivai/witness';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'health');
const CLI = path.join(path.dirname(require.resolve('@testivai/witness')), 'bin', 'testivai.js');
const PAGES = ['/font-404.html', '/css-404.html', '/img-404.html', '/healthy.html', '/font-fallback.html', '/preload-404.html', '/xhr-css-404.html'];

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

function png(): Buffer {
  const image = new PNG({ width: 40, height: 40 });
  image.data.fill(200);
  return PNG.sync.write(image);
}

function serve(fontFile: string): Promise<http.Server> {
  const font = fs.readFileSync(fontFile);
  const image = png();
  const files: Record<string, [string, () => Buffer]> = {
    '/css/font-404.css': ['text/css', () => fs.readFileSync(path.join(FIXTURES, 'font-404.css'))],
    '/css/healthy.css': ['text/css', () => fs.readFileSync(path.join(FIXTURES, 'healthy.css'))],
    '/fonts/fancy.ttf': ['font/ttf', () => font],
    '/img/ok.png': ['image/png', () => image],
  };
  for (const page of PAGES) files[page] = ['text/html; charset=utf-8', () => fs.readFileSync(path.join(FIXTURES, page.slice(1)))];
  const server = http.createServer((req, res) => {
    const file = files[(req.url ?? '').split('?')[0]];
    res.writeHead(file ? 200 : 404, { 'content-type': file ? file[0] : 'text/plain', 'cache-control': 'no-store' });
    res.end(file ? file[1]() : 'not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const HEALTHY: CaptureHealth = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};

function expected(host: string): Record<string, CaptureHealth> {
  return {
    '/font-404.html': {
      ...HEALTHY,
      fonts: { status: 'loaded', failed: [{ family: 'Missing', weight: 'normal', style: 'normal' }] },
      resources: { status: 'checked', failed: { font: { count: 1, entries: [{ url: `${host}/fonts/missing.woff2`, status: 404 }] } } },
    },
    '/css-404.html': {
      ...HEALTHY,
      stylesheets: { failed: 1, urls: [`${host}/css/missing.css`] },
      resources: { status: 'checked', failed: { css: { count: 1, entries: [{ url: `${host}/css/missing.css`, status: 404 }] } } },
    },
    '/img-404.html': {
      ...HEALTHY,
      images: { broken: 1, urls: [`${host}/img/missing.png`] },
      resources: { status: 'checked', failed: { img: { count: 1, entries: [{ url: `${host}/img/missing.png`, status: 404 }] } } },
    },
    '/healthy.html': HEALTHY,
    '/font-fallback.html': {
      ...HEALTHY,
      resources: { status: 'checked', failed: { font: { count: 1, entries: [{ url: `${host}/fonts/missing.woff2`, status: 404 }] } } },
    },
    '/preload-404.html': {
      ...HEALTHY,
      resources: { status: 'checked', failed: { other: { count: 1, entries: [{ url: `${host}/_next/image`, status: 404 }] } } },
    },
    '/xhr-css-404.html': {
      ...HEALTHY,
      resources: { status: 'checked', failed: { other: { count: 1, entries: [{ url: `${host}/css/theme.css`, status: 404 }] } } },
    },
  };
}

function runCli(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, timeout: 180_000, env: { ...process.env } }, (_err, stdout, stderr) =>
      resolve(`${stdout}\n${stderr}`),
    );
  });
}

async function main(): Promise<void> {
  const chrome = findChrome();
  const fontFile = findFont();
  if (!chrome || !fontFile) {
    const missing = !chrome ? 'no Chrome/Chromium (set TESTIVAI_CHROME_PATH)' : 'no TrueType font to serve';
    assert.ok(!process.env.CI, `CI has ${missing}`);
    console.log(`[e2e] ⚠ SKIPPED health probe: ${missing}`);
    return;
  }
  assert.ok(fs.existsSync(CLI), `CLI not built: ${CLI} (run pnpm build first)`);

  const server = await serve(fontFile);
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const want = expected(host);
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-e2e-health-probe-'));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    // 1. The probe, in each page.
    for (const page of PAGES) {
      const context = await browser.newContext();
      const tab = await context.newPage();
      await tab.goto(`http://${host}${page}`, { waitUntil: 'load' });
      await tab.evaluate('document.fonts.ready.then(function () { return true; })');
      const raw = await tab.evaluate(HEALTH_PROBE_EXPRESSION);
      assert.ok(!JSON.stringify(raw).includes('s3cret'), `${page}: a query string was recorded`);
      assert.deepStrictEqual(parseHealth(raw), want[page], `${page}: the probe's health`);
      await context.close();
    }
    console.log(
      '[e2e] ✓ The health probe reads a failed web font, a failed stylesheet, a broken image, a healthy page, a font source fallback, an image preload and a script request for a .css file exactly.',
    );

    // 2. The standalone crawler records the same, with what it saw on the network.
    fs.mkdirSync(path.join(projectRoot, '.testivai'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.testivai', 'config.json'), JSON.stringify({ autoOpen: false }));
    const output = await runCli(['witness', `http://${host}`, '--pages', PAGES.join(',')], projectRoot);
    if (/No Chrome\/Chromium found/.test(output)) {
      assert.ok(!process.env.CI, 'CI has no Chrome/Chromium for the CLI; set TESTIVAI_CHROME_PATH');
      console.log('[e2e] ⚠ SKIPPED health probe (standalone part): the CLI found no Chrome/Chromium');
      return;
    }
    for (const page of PAGES) {
      const name = page.slice(1).replace('.', '_');
      const metaPath = path.join(projectRoot, '.testivai', 'temp', name, 'metadata.json');
      assert.ok(fs.existsSync(metaPath), `${page}: no capture\n${output}`);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      // The network names what the preload requested (an image), which the
      // page alone could not tell: the request moves to that group, once.
      const crawled =
        page === '/preload-404.html'
          ? { ...want[page], resources: { status: 'checked', failed: { img: { count: 1, entries: [{ url: `${host}/_next/image`, status: 404 }] } } } }
          : want[page];
      assert.deepStrictEqual(meta.health, crawled, `${page}: the crawler's health`);
    }
    const results = JSON.parse(fs.readFileSync(path.join(projectRoot, 'visual-report', 'results.json'), 'utf-8'));
    const health = (name: string) => results.snapshots.find((s: { name: string }) => s.name === name)?.captureHealth;
    assert.strictEqual(health('font-404_html')?.unhealthy, 'candidate');
    assert.strictEqual(health('css-404_html')?.unhealthy, 'candidate');
    assert.deepStrictEqual(health('css-404_html')?.reasons, [`stylesheet ${host}/css/missing.css returned 404`]);
    assert.strictEqual(health('img-404_html')?.unhealthy, null);
    assert.deepStrictEqual(health('img-404_html')?.warnings, [`image ${host}/img/missing.png returned 404`]);
    assert.strictEqual(health('healthy_html')?.unhealthy, null);
    assert.strictEqual(health('font-fallback_html')?.unhealthy, null, 'a face that loaded from its next source is not a failed web font');
    assert.deepStrictEqual(health('font-fallback_html')?.warnings, [`font file ${host}/fonts/missing.woff2 returned 404`]);
    assert.strictEqual(health('preload-404_html')?.unhealthy, null, 'an image preload is not a stylesheet');
    assert.deepStrictEqual(health('preload-404_html')?.warnings, [`image ${host}/_next/image returned 404`]);
    assert.strictEqual(health('xhr-css-404_html')?.unhealthy, null, 'a script request for a .css file is not a stylesheet');
    assert.deepStrictEqual(health('xhr-css-404_html')?.warnings, [`request ${host}/css/theme.css returned 404`]);
    console.log('[e2e] ✓ testivai witness <url> records the same health per capture, and results.json reads it.');
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[e2e] ✗ Health probe E2E failed');
  console.error(err);
  process.exit(1);
});
