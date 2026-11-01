/**
 * Mobile plan, Track 2: a hybrid app's WebView on a real Android emulator
 * (Appium 3 + UiAutomator2, the fixture app in e2e/fixtures/android-webview:
 * the system action bar around a WebView showing a small orders page).
 *
 * Inside the WebView context the WebdriverIO adapter takes the web path, so
 * every layer should work as on a web page. The plan simulated this in
 * Chromium; this checks it on a real WebView:
 *
 *   1. In the WEBVIEW context, witness() is not native mode: screenshot.png,
 *      dom.html, elements.json and metadata.json, the environment names the
 *      WebView's Chromium, capture method viewport:webdriver, no device key.
 *   2. The same page again: passed.
 *   3. A button colour changed through the CSSOM (no DOM change): changed,
 *      DOM unchanged, style check "mismatch" on the button.
 *   4. The title text: changed, one text change in the DOM diff.
 *   5. A banner inserted at the top: changed, and the cards below read as a
 *      shift.
 *   6. Back in the NATIVE_APP context, the same screen is a native capture
 *      (Level 1): pixel-only, keyed by device.
 *   7. Still in NATIVE_APP, `context: 'webview'` captures the web view as a
 *      page: it matches the baseline from step 1, and the session is back in
 *      NATIVE_APP afterwards.
 *
 * Every step's screenshot, summary.json and the report go to
 * $TESTIVAI_WEBVIEW_OUT. Runs after the native check in
 * e2e/scripts/android-native.sh, with $TESTIVAI_WEBVIEW_APK built by
 * e2e/scripts/build-webview-apk.sh and Appium allowed to download the
 * chromedriver that matches the WebView.
 */

import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { remote } from 'webdriverio';

import { BaselineStore, generateReport } from '@testivai/witness';
import { witness } from '@testivai/witness-webdriverio';

import { adb, appInFront, checklist, prepareDevice, restoreDevice, sleep } from './android-helpers';

const OUT = process.env.TESTIVAI_WEBVIEW_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-webview-out-'));
const APK = process.env.TESTIVAI_WEBVIEW_APK;
const CLI = path.join(path.dirname(require.resolve('@testivai/witness')), 'bin', 'testivai.js');
const APP_PACKAGE = 'ai.testiv.webviewfixture';
const COMPONENT = `${APP_PACKAGE}/.MainActivity`;
const WEBVIEW = `WEBVIEW_${APP_PACKAGE}`;

const summary: Record<string, unknown> = { steps: [] as unknown[] };
const steps = summary.steps as unknown[];
const { expect, failures } = checklist('webview');

async function main(): Promise<void> {
  assert.ok(APK && fs.existsSync(APK), `TESTIVAI_WEBVIEW_APK is not a built APK: ${APK}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-webview-'));
  fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ autoOpen: false }));
  process.chdir(root);
  prepareDevice();

  const session = await remote({
    hostname: '127.0.0.1',
    port: 4723,
    path: '/',
    logLevel: 'warn',
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:app': APK,
      'appium:appWaitActivity': '*',
      'appium:newCommandTimeout': 300,
    },
  });

  try {
    const caps = session.capabilities as Record<string, unknown>;
    summary.capabilities = caps;
    const front = await appInFront(session, APP_PACKAGE, COMPONENT, 'start');
    summary.front = front;

    // The WebView's context appears once its page is up.
    let contexts: string[] = [];
    for (let i = 0; i < 30 && !contexts.includes(WEBVIEW); i++) {
      contexts = (await session.getContexts()) as string[];
      if (!contexts.includes(WEBVIEW)) await sleep(1000);
    }
    summary.contexts = contexts;
    console.log(`[webview] contexts: ${JSON.stringify(contexts)}`);
    assert.ok(contexts.includes(WEBVIEW), `fixture: no ${WEBVIEW} context (WebView debugging off, or no chromedriver): ${JSON.stringify(contexts)}`);

    const intoWebView = async () => {
      await session.switchContext(WEBVIEW);
      for (let i = 0; i < 20; i++) {
        if (await session.execute('return document.readyState === "complete" && !!document.getElementById("title")')) return;
        await sleep(500);
      }
      throw new Error('fixture: the page did not load in the WebView');
    };
    // The emulator once lost the app while Appium started chromedriver (the
    // WebView context vanished). Recover once, by relaunching the app, and
    // record it: a second failure fails the run.
    const recoveries: string[] = [];
    summary.recoveries = recoveries;
    const toWebView = async () => {
      try {
        await intoWebView();
      } catch (err) {
        let pid = '';
        try {
          pid = adb('shell', 'pidof', APP_PACKAGE);
        } catch {
          // pidof exits 1 when there is no such process
        }
        recoveries.push(`switching into the web view failed (${String((err as Error).message).split('\n')[0].slice(0, 160)}); app process ${pid ? `alive (${pid})` : 'gone'}; relaunched`);
        await session.switchContext('NATIVE_APP').catch(() => undefined);
        await appInFront(session, APP_PACKAGE, COMPONENT, 'recovery');
        for (let i = 0; i < 30 && !((await session.getContexts()) as string[]).includes(WEBVIEW); i++) await sleep(1000);
        await intoWebView();
      }
    };
    // The page as the app ships it: what every step starts from. Checked,
    // never assumed (a location.reload() in the WebView did not reset it).
    const PRISTINE =
      'return document.getElementById("title").textContent === "Your orders" && !document.getElementById("banner") && document.styleSheets[0].cssRules.length === arguments[0]';
    const UNDO =
      'var t = document.getElementById("title"); t.textContent = "Your orders"; var b = document.getElementById("banner"); if (b) b.remove(); var sheet = document.styleSheets[0]; while (sheet.cssRules.length > arguments[0]) sheet.deleteRule(sheet.cssRules.length - 1);';
    const resets: string[] = [];
    summary.resets = resets;
    let ruleCount = 0;
    const reset = async (before: string) => {
      await session.url('file:///android_asset/index.html');
      await toWebView();
      if (await session.execute(PRISTINE, ruleCount)) {
        resets.push(`${before}: reloaded`);
        return;
      }
      await session.execute(UNDO, ruleCount);
      if (!(await session.execute(PRISTINE, ruleCount))) throw new Error(`fixture: the page could not be reset before ${before}`);
      resets.push(`${before}: undone by script (navigation did not reset it)`);
    };
    await toWebView();
    ruleCount = (await session.execute('return document.styleSheets[0].cssRules.length')) as number;
    assert.ok(await session.execute(PRISTINE, ruleCount), 'fixture: the page does not start as shipped');
    const dpr = (await session.execute('return window.devicePixelRatio')) as number;
    summary.devicePixelRatio = dpr;

    const browser = {
      capabilities: caps,
      takeScreenshot: () => session.takeScreenshot(),
      getContext: () => session.getContext(),
      getContexts: () => session.getContexts(),
      switchContext: (name: string) => session.switchContext(name),
      execute: (script: unknown, ...args: unknown[]) =>
        (session.execute as (s: unknown, ...a: unknown[]) => Promise<unknown>)(script, ...args),
    };

    const store = new BaselineStore(root);
    fs.mkdirSync(path.join(OUT, 'steps'), { recursive: true });
    const capture = async (step: string, name: string, options: Parameters<typeof witness>[2] = {}) => {
      await sleep(1000);
      const started = Date.now();
      await witness(browser as unknown as Parameters<typeof witness>[0], name, options);
      const ms = Date.now() - started;
      const written = fs.readdirSync(path.join(root, '.testivai', 'temp'));
      const dir = written.find((d) => d === name || d.startsWith(`${name}__`));
      if (!dir) throw new Error(`${step}: nothing written for ${name}; temp has ${JSON.stringify(written)}`);
      const tempDir = path.join(root, '.testivai', 'temp', dir);
      const files = fs.readdirSync(tempDir).sort();
      const png = PNG.sync.read(fs.readFileSync(path.join(tempDir, 'screenshot.png')));
      fs.copyFileSync(path.join(tempDir, 'screenshot.png'), path.join(OUT, 'steps', `${step.split('.')[0]}.png`));
      const metadata = fs.existsSync(path.join(tempDir, 'metadata.json'))
        ? JSON.parse(fs.readFileSync(path.join(tempDir, 'metadata.json'), 'utf-8'))
        : null;
      const record = { step, dir, witnessMs: ms, files, screenshot: `${png.width}x${png.height}`, metadata };
      steps.push(record);
      console.log(`[webview] ${step}: ${dir}, witness ${ms} ms, files ${files.join(', ')}, ${record.screenshot}`);
      return record;
    };
    const report = (name: string) => {
      const s = generateReport({ projectRoot: root, autoOpen: false }).snapshots.find((x) => x.name === name);
      assert.ok(s, `no result for ${name}`);
      console.log(`[webview]     ${s.status} ${s.diffPercent.toFixed(3)}%, dom ${JSON.stringify(s.dom)}, regions ${JSON.stringify((s.regions ?? []).map((r) => ({ y: r.y, h: r.height, c: r.classification, shift: r.shift })))}`);
      return s;
    };

    // 1. In the WebView: the web path, every layer.
    const first = await capture('1. webview', 'orders');
    const env = first.metadata?.environment ?? {};
    expect(first.dir === 'orders', `1. not native mode in the WebView: the name has no device key — ${first.dir}`);
    expect(first.files.join(',') === 'dom.html,elements.json,metadata.json,screenshot.png', `1. dom.html, elements.json and metadata.json are written — ${first.files.join(', ')}`);
    expect(env.browser?.name === 'chromium' && env.adapter?.captureMethod === 'viewport:webdriver', `1. environment: the WebView's Chromium, viewport capture — ${JSON.stringify({ browser: env.browser, captureMethod: env.adapter?.captureMethod })}`);
    expect(report('orders').status === 'new', '1. status "new"');
    const approve = spawnSync(process.execPath, [CLI, 'approve', '--all'], { cwd: root, encoding: 'utf-8' });
    expect(approve.status === 0 && store.exists('orders'), `1. testivai approve --all — exit ${approve.status}`);
    store.clearTemp();

    // 2. The same page.
    await capture('2. same page', 'orders');
    const same = report('orders');
    expect(same.status === 'passed' && same.diffCount === 0, `2. the same page passes — ${same.status}, ${same.diffCount} px`);
    store.clearTemp();

    // 3. A colour changed through the CSSOM: the DOM does not change.
    await session.execute('document.styleSheets[0].insertRule(".cta { background: #2e7d32; }", document.styleSheets[0].cssRules.length)');
    await capture('3. button colour', 'orders');
    const colour = report('orders');
    const styled = colour.dom?.styleChanges?.elements ?? [];
    expect(colour.status === 'changed' && colour.dom?.changed === false, `3. a CSS-only change: changed, DOM unchanged — ${colour.status}, dom.changed ${colour.dom?.changed}`);
    expect(colour.dom?.styleCheck === 'mismatch' && styled.some((e) => /button|cta/.test(e)), `3. style check names the button — ${colour.dom?.styleCheck} ${JSON.stringify(styled)}`);
    store.clearTemp();
    await reset('4');

    // 4. The title text.
    await session.execute('document.getElementById("title").textContent = "Your recent orders"');
    await capture('4. title text', 'orders');
    const title = report('orders');
    const s4 = title.dom?.summary;
    expect(title.status === 'changed' && s4?.textChanges === 1 && s4?.added === 0 && s4?.removed === 0, `4. one text change in the DOM diff — ${title.status}, ${JSON.stringify(s4)}`);
    store.clearTemp();
    await reset('5');

    // 5. A banner at the top pushes the cards down.
    await session.execute(
      'var b = document.createElement("div"); b.id = "banner"; b.textContent = "Free shipping this week"; b.style.cssText = "height:60px;background:#ffe082;padding:0 16px;line-height:60px"; document.body.insertBefore(b, document.body.firstChild)',
    );
    await capture('5. banner', 'orders');
    const banner = report('orders');
    const shifts = (banner.regions ?? []).filter((r) => r.classification === 'shift');
    summary.banner = { expectedDy: Math.round(60 * dpr), shifts: shifts.map((r) => r.shift), pageShift: banner.pageShift };
    expect(banner.status === 'changed' && shifts.length > 0, `5. the cards below the banner read as a shift — ${shifts.length} shift regions ${JSON.stringify(shifts.map((r) => r.shift))}, 60 CSS px = ${Math.round(60 * dpr)} px`);
    store.clearTemp();
    await reset('6');

    // 6. The same screen from the native context: a native capture (Level 1).
    await session.switchContext('NATIVE_APP');
    const native = await capture('6. native context', 'orders');
    expect(native.dir.startsWith('orders__android-') && native.files.join(',') === 'metadata.json,screenshot.png', `6. from NATIVE_APP it is a native capture, pixel-only and keyed by device — ${native.dir}: ${native.files.join(', ')}`);
    store.clearTemp();

    // 7. The option: from NATIVE_APP, capture the web view as a page.
    const viaOption = await capture('7. context option', 'orders', { context: 'webview' });
    const after = await session.getContext();
    const option = report('orders');
    summary.contextOption = { contextAfter: after, status: option.status, diffCount: option.diffCount };
    expect(viaOption.dir === 'orders' && viaOption.files.includes('dom.html') && viaOption.files.includes('elements.json'), `7. context: 'webview' captures the web view as a page — ${viaOption.dir}: ${viaOption.files.join(', ')}`);
    expect(option.status === 'passed' && option.diffCount === 0, `7. it matches the baseline taken inside the web view — ${option.status}, ${option.diffCount} px`);
    expect(after === 'NATIVE_APP', `7. the session is back in NATIVE_APP — ${after}`);

    fs.cpSync(path.join(root, 'visual-report'), path.join(OUT, 'visual-report'), { recursive: true });
  } finally {
    restoreDevice();
    await session.deleteSession().catch(() => {});
    summary.failures = failures;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`[webview] summary written to ${path.join(OUT, 'summary.json')}`);
  }

  assert.deepStrictEqual(failures, [], 'the adapter does not hold in a real WebView');
  console.log('[webview] ✓ Every layer holds in a real Android WebView.');
}

main().catch((err) => {
  console.error('[webview] ✗ WebView check failed');
  console.error(err);
  process.exit(1);
});
