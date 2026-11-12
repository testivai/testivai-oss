/**
 * OSS E2E — capture health through the WebDriver adapters, in real WebDriver
 * sessions against Chrome.
 *
 * @testivai/witness-selenium is driven by selenium-webdriver (on Chrome it
 * takes the full-page CDP capture) and @testivai/witness-webdriverio by
 * WebdriverIO (over WebDriver BiDi, as it runs by default). For each:
 *
 *   1. A page whose stylesheet applies a web font ("Fancy") is captured with
 *      the font served: the capture's metadata.json records `health`, and it
 *      is healthy. It is approved as the baseline.
 *   2. The same page is captured with the font's file answering 404: `health`
 *      names the face that failed and the request, and the report (with
 *      noiseAutoPass on) calls it an unhealthy capture, changed, never render
 *      noise and never auto-passed.
 *   3. A page whose stylesheet answers 404 (its query string carries a
 *      "token"): `health` records it by host and path only, and the report
 *      calls the capture unhealthy.
 *
 * Every capture runs in a session of its own, so nothing the browser cached
 * carries over from one capture to the next.
 *
 * Needs a Chrome/Chromium (TESTIVAI_CHROME_PATH, or one on PATH), a
 * ChromeDriver (TESTIVAI_CHROMEDRIVER_PATH, $CHROMEWEBDRIVER on GitHub's
 * runners, or one on PATH) and a TrueType font file to serve. Without one the
 * test is skipped, loudly, except in CI (CI set), where it fails. ChromeDriver
 * runs with --disable-build-check, so a driver a few versions off the browser
 * still starts (GitHub's runners ship a matching pair).
 *
 * The WebdriverIO half runs only on a Node the e2e's webdriverio supports
 * (its engines field: webdriverio 10 needs Node 22 or later, and on Node 20
 * its HTTP client, undici 8, fails to load). On an older Node it says so and
 * does not run; CI's Node 22 job runs it. The adapter itself supports Node 18
 * and webdriverio 8 and later: this is about the driver library the test uses.
 */

import * as assert from 'assert';
import { type ChildProcess, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { Browser, Builder } from 'selenium-webdriver';
import * as chrome from 'selenium-webdriver/chrome';
import { remote } from 'webdriverio';

import { BaselineStore, type CaptureHealth, generateReport } from '@testivai/witness';
import { type WitnessDriver, witness as seleniumWitness } from '@testivai/witness-selenium';
import { type WitnessBrowser, witness as wdioWitness } from '@testivai/witness-webdriverio';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'health');
const CHROME_ARGS = ['--headless=new', '--no-sandbox', '--window-size=1280,900'];

function which(names: string[]): string | null {
  if (process.platform === 'win32') return null;
  for (const name of names) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf-8' }).trim();
      if (found) return found;
    } catch {
      // not on PATH
    }
  }
  return null;
}

function findChrome(): string | null {
  const fromEnv = process.env.TESTIVAI_CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return which(['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']);
}

function findChromedriver(): string | null {
  const fromEnv = process.env.TESTIVAI_CHROMEDRIVER_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const runner = process.env.CHROMEWEBDRIVER && path.join(process.env.CHROMEWEBDRIVER, 'chromedriver');
  if (runner && fs.existsSync(runner)) return runner;
  return which(['chromedriver']);
}

/** A serif TrueType font to serve as "Fancy": its glyphs differ from the monospace fallback. */
function findFont(): string | null {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf',
    '/System/Library/Fonts/Supplemental/Georgia.ttf',
    '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

interface FixtureServer {
  server: http.Server;
  base: string;
  host: string;
  /** Whether /fonts/fancy.ttf answers with the font (true) or 404 (false). */
  fontAvailable: boolean;
}

function serve(fontFile: string): Promise<FixtureServer> {
  const font = fs.readFileSync(fontFile);
  const state = { fontAvailable: true } as FixtureServer;
  const files: Record<string, [string, string]> = {
    '/fancy.html': ['text/html; charset=utf-8', 'fancy.html'],
    '/css-404.html': ['text/html; charset=utf-8', 'css-404.html'],
    '/css/fancy.css': ['text/css; charset=utf-8', 'fancy.css'],
  };
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    const send = (status: number, type: string, body: Buffer | string) => {
      // no-store: the second capture must not reuse the first one's font.
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const file = files[url];
    if (file) return send(200, file[0], fs.readFileSync(path.join(FIXTURES, file[1])));
    if (url === '/fonts/fancy.ttf' && state.fontAvailable) return send(200, 'font/ttf', font);
    return send(404, 'text/plain', 'not found');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      state.server = server;
      state.host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
      state.base = `http://${state.host}`;
      resolve(state);
    }),
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function startChromedriver(binary: string): Promise<{ process: ChildProcess; port: number }> {
  const port = await freePort();
  const child = spawn(binary, [`--port=${port}`, '--disable-build-check'], { stdio: 'ignore' });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await fetch(`http://127.0.0.1:${port}/status`)
      .then((r) => r.json() as Promise<{ value?: { ready?: boolean } }>)
      .then((body) => body.value?.ready === true)
      .catch(() => false);
    if (ready) return { process: child, port };
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`ChromeDriver (${binary}) did not answer on port ${port}`);
}

/** webdriverio's package.json (not in its exports map, so read from disk). */
const WEBDRIVERIO = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'webdriverio', 'package.json'), 'utf-8')) as {
  version: string;
  engines?: { node?: string };
};

/** Why the e2e's webdriverio cannot run on this Node version, or null when it can. */
function webdriverioUnsupported(nodeVersion: string): string | null {
  if (Number(nodeVersion.split('.')[0]) >= 22) return null;
  return `webdriverio ${WEBDRIVERIO.version} needs Node ${WEBDRIVERIO.engines?.node ?? '22 or later'}, and this is Node ${nodeVersion}`;
}

interface Adapter {
  label: string;
  /** Why this adapter's driver library cannot run here, or null. */
  unsupported: string | null;
  /** Opens the page in a session of its own and captures it as `name`. */
  capture(url: string, name: string): Promise<void>;
}

function adapters(chromePath: string, driverPort: number): Adapter[] {
  return [
    {
      label: '@testivai/witness-selenium (selenium-webdriver)',
      unsupported: null,
      async capture(url, name) {
        const options = new chrome.Options();
        options.setChromeBinaryPath(chromePath);
        options.addArguments(...CHROME_ARGS);
        const driver = await new Builder().forBrowser(Browser.CHROME).usingServer(`http://127.0.0.1:${driverPort}`).setChromeOptions(options).build();
        try {
          assert.strictEqual(typeof (driver as unknown as WitnessDriver).sendAndGetDevToolsCommand, 'function', 'the Chrome driver offers CDP');
          await driver.get(url);
          await seleniumWitness(driver as unknown as WitnessDriver, name);
        } finally {
          await driver.quit();
        }
      },
    },
    {
      label: '@testivai/witness-webdriverio (WebdriverIO)',
      unsupported: webdriverioUnsupported(process.versions.node),
      async capture(url, name) {
        const browser = await remote({
          hostname: '127.0.0.1',
          port: driverPort,
          path: '/',
          logLevel: 'error',
          capabilities: { browserName: 'chrome', 'goog:chromeOptions': { binary: chromePath, args: CHROME_ARGS } },
        });
        try {
          await browser.url(url);
          await wdioWitness(browser as unknown as WitnessBrowser, name);
        } finally {
          await browser.deleteSession();
        }
      },
    },
  ];
}

const HEALTHY: CaptureHealth = {
  fonts: { status: 'loaded', failed: [] },
  stylesheets: { failed: 0, urls: [] },
  images: { broken: 0, urls: [] },
  resources: { status: 'checked', failed: {} },
};

type Report = ReturnType<typeof generateReport>;

/** The three captures, and the health each one records in its metadata.json. */
async function captureAll(adapter: Adapter, fixture: FixtureServer, root: string, store: BaselineStore): Promise<void> {
  const { host } = fixture;
  const tempMetadata = (name: string) => JSON.parse(fs.readFileSync(path.join(root, '.testivai', 'temp', name, 'metadata.json'), 'utf-8'));

  // 1. The font is served: healthy, approved as the baseline.
  fixture.fontAvailable = true;
  await adapter.capture(`${fixture.base}/fancy.html`, 'fancy');
  assert.deepStrictEqual(tempMetadata('fancy').health, HEALTHY, `${adapter.label}: the healthy capture's health`);
  store.approve('fancy');
  store.clearTemp();

  // 2. The font's file answers 404.
  fixture.fontAvailable = false;
  await adapter.capture(`${fixture.base}/fancy.html`, 'fancy');
  assert.deepStrictEqual(
    tempMetadata('fancy').health,
    {
      ...HEALTHY,
      fonts: { status: 'loaded', failed: [{ family: 'Fancy', weight: 'normal', style: 'normal' }] },
      resources: { status: 'checked', failed: { font: { count: 1, entries: [{ url: `${host}/fonts/fancy.ttf`, status: 404 }] } } },
    },
    `${adapter.label}: the failed web font's health`,
  );

  // 3. A stylesheet that answers 404, its query string never recorded.
  await adapter.capture(`${fixture.base}/css-404.html`, 'css-404');
  const css = tempMetadata('css-404');
  assert.deepStrictEqual(
    css.health,
    {
      ...HEALTHY,
      stylesheets: { failed: 1, urls: [`${host}/css/missing.css`] },
      resources: { status: 'checked', failed: { css: { count: 1, entries: [{ url: `${host}/css/missing.css`, status: 404 }] } } },
    },
    `${adapter.label}: the failed stylesheet's health`,
  );
  assert.ok(!JSON.stringify(css).includes('s3cret'), `${adapter.label}: a query string was recorded`);
}

/** The failed web font: changed and unhealthy, never render noise, against a healthy baseline. */
function assertUnhealthyFont(label: string, report: Report, store: BaselineStore): void {
  const fancy = report.snapshots.find((s) => s.name === 'fancy');
  assert.ok(fancy, `${label}: no result for fancy`);
  const health = fancy.captureHealth;
  console.log(
    `[e2e]   ${label} fancy: ${fancy.status}${fancy.autoPassed ? ` (auto-passed: ${fancy.autoPassed})` : ''}, ` +
      `${fancy.diffPercent.toFixed(3)}% (${fancy.diffCount} px), captureHealth ${JSON.stringify(health && { unhealthy: health.unhealthy, reasons: health.reasons })}`,
  );
  assert.ok(fancy.diffCount > 0, `${label}: the fallback font changed no pixel: the fixture did not reproduce the failure`);
  assert.strictEqual(fancy.autoPassed, undefined, `${label}: auto-passed as "${fancy.autoPassed}": an unhealthy capture is never render noise`);
  assert.strictEqual(fancy.status, 'changed');
  assert.strictEqual(fancy.dom?.noiseHint, false, `${label}: no noise hint for an unhealthy capture`);
  assert.ok(health, `${label}: no captureHealth`);
  assert.strictEqual(health.unhealthy, 'candidate');
  assert.ok(
    health.reasons.some((r) => r.includes("web font 'Fancy' failed to load")),
    `${label}: the reasons name the font: ${JSON.stringify(health.reasons)}`,
  );
  // The baseline was healthy, and its health was frozen on approve.
  assert.deepStrictEqual(store.readMetadata('fancy')?.health, HEALTHY, `${label}: the healthy baseline`);
}

/** The failed stylesheet: unhealthy, named by host and path. */
function assertUnhealthyStylesheet(label: string, report: Report, host: string): void {
  const health = report.snapshots.find((s) => s.name === 'css-404')?.captureHealth;
  assert.ok(health, `${label}: no captureHealth for css-404`);
  assert.strictEqual(health.unhealthy, 'candidate');
  assert.deepStrictEqual(health.reasons, [`stylesheet ${host}/css/missing.css returned 404`]);
}

async function check(adapter: Adapter, fixture: FixtureServer): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-oss-e2e-webdriver-health-'));
  fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ noiseAutoPass: true, autoOpen: false }));
  const cwd = process.cwd();
  try {
    // The adapter writes under process.cwd(), like a test run in the project.
    process.chdir(root);
    const store = new BaselineStore(root);
    await captureAll(adapter, fixture, root, store);
    // The report (noiseAutoPass on) reads both as unhealthy captures.
    const report = generateReport({ projectRoot: root, autoOpen: false });
    assertUnhealthyFont(adapter.label, report, store);
    assertUnhealthyStylesheet(adapter.label, report, fixture.host);
    console.log(`[e2e] ✓ ${adapter.label} records capture health, and a failed web font or stylesheet reads as an unhealthy capture.`);
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const chromePath = findChrome();
  const driverPath = findChromedriver();
  const fontFile = findFont();
  if (!chromePath || !driverPath || !fontFile) {
    const missing = !chromePath
      ? 'no Chrome/Chromium (set TESTIVAI_CHROME_PATH)'
      : !driverPath
        ? 'no ChromeDriver (set TESTIVAI_CHROMEDRIVER_PATH)'
        : 'no TrueType font to serve';
    assert.ok(!process.env.CI, `CI has ${missing}`);
    console.log(`[e2e] ⚠ SKIPPED WebDriver capture health: ${missing}`);
    return;
  }

  const fixture = await serve(fontFile);
  const driver = await startChromedriver(driverPath);
  try {
    for (const adapter of adapters(chromePath, driver.port)) {
      if (adapter.unsupported) console.log(`[e2e] ⚠ NOT RUN here: ${adapter.label}, as ${adapter.unsupported}. CI's Node 22 job runs it.`);
      else await check(adapter, fixture);
    }
  } finally {
    driver.process.kill();
    fixture.server.close();
  }
}

main().catch((err) => {
  console.error('[e2e] ✗ WebDriver capture health E2E failed');
  console.error(err);
  process.exit(1);
});
