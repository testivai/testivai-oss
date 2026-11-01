/**
 * Mobile plan, Track 1 Level 1: the WebdriverIO adapter's native mode on a
 * real Android emulator (Appium 3 + UiAutomator2, Android's own Settings
 * app). The gate: a green loop.
 *
 *   1. witness() on a native screen: status "new"; screenshot.png and
 *      metadata.json, no DOM; no page script runs and WebdriverIO resends
 *      nothing; the environment block names the device (browser "native-app",
 *      capture method "screen:appium"); the status bar is masked
 *      (masks [{ top }] from mobile: viewportRect); the snapshot is keyed
 *      <name>__android-<model>-<osMajor>. `testivai approve --all` approves it.
 *   2. The same screen again: passed, with no DOM reading in results.json.
 *   3. Only the status-bar clock moves (demo mode, 12:00 → 12:01): passed
 *      with no config mask, the automatic one alone. The clock change is
 *      checked in the screenshots themselves, so the pass is the mask's.
 *   4. A visible change (dark mode): "changed", and
 *      `testivai report --fail-on-diff` exits 1.
 *
 * Level 0 (the adapter before native mode) measured each rejected page script
 * at ~1.5 s, almost all WebdriverIO retries, and ~8 s per capture; the time of
 * each capture is recorded here for comparison, not gated.
 *
 * The screen is checked before trusting any of that: Settings must be the
 * focused window before every capture (a "not responding" dialog left by a
 * slow boot is dismissed), the first capture must be light and the dark-mode
 * capture dark (`cmd uimode night` and the pixels). A run that captured
 * something else fails as a fixture problem. Every step's screenshot is kept
 * in $TESTIVAI_ANDROID_OUT/steps, with summary.json and the visual report.
 *
 * Runs in .github/workflows/android-native.yml, inside
 * reactivecircus/android-emulator-runner, with Appium on 127.0.0.1:4723 and
 * adb on PATH. Not part of `pnpm e2e`: it needs an emulator.
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

import { adb, appInFront, checklist, demo, differingPixels, meanLuma, prepareDevice, restoreDevice, sleep } from './android-helpers';

const OUT = process.env.TESTIVAI_ANDROID_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-android-out-'));
const CLI = path.join(path.dirname(require.resolve('@testivai/witness')), 'bin', 'testivai.js');

const summary: Record<string, unknown> = { steps: [] as unknown[] };
const steps = summary.steps as unknown[];
const { expect, failures } = checklist('android');

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-android-'));
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
      'appium:appPackage': 'com.android.settings',
      'appium:appActivity': '.Settings',
      'appium:noReset': true,
      // Settings is already running on a booted emulator; without this,
      // Appium leaves whatever is in front.
      'appium:forceAppLaunch': true,
      // `.Settings` is an alias: the activity that opens is the homepage.
      'appium:appWaitActivity': '*',
      'appium:newCommandTimeout': 300,
    },
  });

  try {
    const caps = session.capabilities as Record<string, unknown>;
    summary.capabilities = caps;
    const viewportRect = (await session.execute('mobile: viewportRect')) as { top: number };
    const statusBar = viewportRect.top;
    // The key the adapter should use, read from the capabilities here.
    const model = String(caps.deviceModel ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const osMajor = String(caps.platformVersion ?? '').split('.')[0];
    const NAME = `settings__android-${model}-${osMajor}`;
    summary.expected = { name: NAME, statusBar };
    console.log(`[android] device ${JSON.stringify({ model: caps.deviceModel, platformVersion: caps.platformVersion, viewportRect })}; expecting ${NAME}`);

    // WebdriverIO resends a command after an error response; count every resend.
    let retries = 0;
    session.on('request.retry', () => {
      retries++;
    });

    // The session as the adapter sees it, with every execute() recorded.
    const scripts: string[] = [];
    const browser = {
      capabilities: caps,
      takeScreenshot: () => session.takeScreenshot(),
      getContext: () => session.getContext(),
      execute: (script: unknown, ...args: unknown[]) => {
        scripts.push(String(script).slice(0, 60));
        return (session.execute as (s: unknown, ...a: unknown[]) => Promise<unknown>)(script, ...args);
      },
    };

    const store = new BaselineStore(root);
    const tempDir = path.join(root, '.testivai', 'temp', NAME);
    fs.mkdirSync(path.join(OUT, 'steps'), { recursive: true });
    const pngs: Record<string, PNG> = {};
    const capture = async (step: string) => {
      await sleep(2000);
      const front = await appInFront(session, 'com.android.settings', 'com.android.settings/.Settings', step);
      scripts.length = 0;
      const retriesBefore = retries;
      const started = Date.now();
      await witness(browser as unknown as Parameters<typeof witness>[0], 'settings');
      const ms = Date.now() - started;
      if (!fs.existsSync(tempDir)) {
        const written = fs.existsSync(path.dirname(tempDir)) ? fs.readdirSync(path.dirname(tempDir)) : [];
        throw new Error(`${step}: native mode did not key the capture as ${NAME}; temp has ${JSON.stringify(written)}`);
      }
      const files = fs.readdirSync(tempDir).sort();
      const png = PNG.sync.read(fs.readFileSync(path.join(tempDir, 'screenshot.png')));
      const key = step.split('.')[0];
      pngs[key] = png;
      fs.copyFileSync(path.join(tempDir, 'screenshot.png'), path.join(OUT, 'steps', `${key}.png`));
      const luma = Math.round(meanLuma(png, statusBar));
      const metadata = JSON.parse(fs.readFileSync(path.join(tempDir, 'metadata.json'), 'utf-8'));
      const record = { step, focus: front.focus, actionsBefore: front.actions, luma, witnessMs: ms, files, screenshot: `${png.width}x${png.height}`, scripts: [...scripts], retries: retries - retriesBefore, metadata };
      steps.push(record);
      console.log(`[android] ${step}: witness ${ms} ms, files ${files.join(', ')}, ${record.screenshot}, mean luma ${luma}, scripts ${JSON.stringify(record.scripts)}, retries ${record.retries}`);
      console.log(`[android]     in front: ${front.focus}${front.actions.length ? ` (after: ${front.actions.join('; ')})` : ''}`);
      return record;
    };
    const report = () => {
      const s = generateReport({ projectRoot: root, autoOpen: false }).snapshots.find((x) => x.name === NAME);
      assert.ok(s, `no result for ${NAME}`);
      console.log(`[android]     ${s.status} ${s.diffPercent.toFixed(4)}% (${s.diffCount} px), masks ${JSON.stringify(s.masks ?? [])}, regions ${JSON.stringify((s.regions ?? []).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })))}`);
      return s;
    };

    // 1. First capture.
    const first = await capture('1. first capture');
    expect(first.luma >= 160, `fixture: the light Settings screen is light — mean luma ${first.luma}`);
    expect(report().status === 'new', `1. a native screen is captured as ${NAME}, status "new"`);
    expect(first.files.join(',') === 'metadata.json,screenshot.png', `1. screenshot.png and metadata.json, no DOM — got ${first.files.join(', ')}`);
    expect(first.scripts.every((s) => s.startsWith('mobile:')), `1. no page script runs — execute() calls: ${JSON.stringify(first.scripts)}`);
    expect(first.retries === 0, `1. WebdriverIO resends nothing — ${first.retries} retries`);
    const env = first.metadata.environment ?? {};
    expect(env.browser?.name === 'native-app' && env.adapter?.captureMethod === 'screen:appium', `1. environment: browser native-app, capture method screen:appium — ${JSON.stringify({ browser: env.browser, captureMethod: env.adapter?.captureMethod })}`);
    expect(
      env.device?.platform === 'android' && env.device?.osVersion === caps.platformVersion && env.device?.model === caps.deviceModel,
      `1. environment: the device from the capabilities — ${JSON.stringify(env.device)}`,
    );
    expect(JSON.stringify(first.metadata.masks) === JSON.stringify([{ top: statusBar }]), `1. the status bar is masked: masks ${JSON.stringify(first.metadata.masks)}, status bar ${statusBar} px`);

    const approve = spawnSync(process.execPath, [CLI, 'approve', '--all'], { cwd: root, encoding: 'utf-8' });
    expect(approve.status === 0 && store.exists(NAME), `1. testivai approve --all approves it — exit ${approve.status}`);
    store.clearTemp();

    // 2. The same screen.
    const second = await capture('2. same screen');
    const same = report();
    expect(same.status === 'passed', `2. the same screen passes — ${same.status}, ${same.diffCount} px`);
    expect(same.dom == null, `2. no DOM reading for a native snapshot — dom ${JSON.stringify(same.dom)}`);
    expect(second.retries === 0 && second.scripts.every((s) => s.startsWith('mobile:')), '2. again no page script and no resend');
    store.clearTemp();

    // 3. Only the clock moves; no config mask.
    demo('clock', '-e', 'hhmm', '1201');
    await capture('3. clock 12:01');
    const moved = differingPixels(pngs['2'], pngs['3'], statusBar);
    summary.clockChange = { ...moved, statusBar };
    expect(moved.above > 0, `fixture: the clock change is in the screenshots — ${moved.above} px differ in the status bar, ${moved.below} below it`);
    const clock = report();
    expect(clock.status === 'passed' && clock.diffCount === 0, `3. a clock change passes with the automatic mask alone — ${clock.status}, ${clock.diffCount} px`);
    store.clearTemp();

    // 4. A visible change: dark mode.
    adb('shell', 'cmd', 'uimode', 'night', 'yes');
    await sleep(3000);
    const darkCapture = await capture('4. dark mode');
    const nightMode = adb('shell', 'cmd', 'uimode', 'night');
    expect(/yes/i.test(nightMode) && darkCapture.luma <= 90, `fixture: the dark-mode capture is dark — ${nightMode}, mean luma ${darkCapture.luma}`);
    const dark = report();
    expect(dark.status === 'changed', `4. dark mode is a change — ${dark.status}, ${dark.diffPercent.toFixed(2)}%`);
    const gate = spawnSync(process.execPath, [CLI, 'report', '--fail-on-diff'], { cwd: root, encoding: 'utf-8' });
    expect(gate.status === 1, `4. testivai report --fail-on-diff exits 1 — exit ${gate.status}`);

    fs.cpSync(path.join(root, 'visual-report'), path.join(OUT, 'visual-report'), { recursive: true });
  } finally {
    restoreDevice();
    await session.deleteSession().catch(() => {});
    summary.failures = failures;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`[android] summary written to ${path.join(OUT, 'summary.json')}`);
  }

  assert.deepStrictEqual(failures, [], 'native mode did not hold on the Android emulator');
  console.log('[android] ✓ Native mode holds on a real Android emulator.');
}

main().catch((err) => {
  console.error('[android] ✗ Level 1 check failed');
  console.error(err);
  process.exit(1);
});
