/**
 * Mobile plan, Track 1 Level 1: the WebdriverIO adapter's native mode on a
 * real Android emulator (Appium 3 + UiAutomator2, Android's own Settings
 * app). The gate: a green loop.
 *
 *   1. witness() on a native screen: status "new"; screenshot.png and
 *      metadata.json, no DOM; no page script runs and WebdriverIO resends
 *      nothing; the environment block names the device (browser "native-app",
 *      capture method "screen:appium"); the status bar is masked
 *      (masks [{ top }]) to the bottom of the bar's frame in the window
 *      manager (mobile: getSystemBars, one call); the snapshot is keyed
 *      <name>__android-<model>-<osMajor>. `testivai approve --all` approves it.
 *   2. The same screen again: passed, with no DOM reading in results.json.
 *   3. Only the status-bar clock moves (demo mode, 12:00 → 12:01): passed
 *      with no config mask, the automatic one alone. The clock change is
 *      checked in the screenshots themselves, so the pass is the mask's, and
 *      its last changed row must be inside the window manager's bar.
 *   4. A visible change (dark mode): "changed", and
 *      `testivai report --fail-on-diff` exits 1.
 *   5. Turned to landscape after the session started: UiAutomator2's own
 *      reading (mobile: viewportRect) stays at the height it read when the
 *      session started; the mask follows the window manager's landscape bar.
 *   6. The clock moves in landscape: passed with the automatic mask alone.
 *
 * Each run records both status bar readings at the session start:
 * UiAutomator2's (read once, from a resource of its server app) and the
 * window manager's. They differed in one CI run (63 px for a 136 px bar),
 * when the adapter still used UiAutomator2's and the clock change failed;
 * when they differ again, steps 1 and 3 show the mask still covers the bar.
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

import {
  adb,
  appInFront,
  checklist,
  demo,
  differingPixels,
  lastDifferingRow,
  meanLuma,
  prepareDevice,
  restoreDevice,
  rotateAndWait,
  sleep,
} from './android-helpers';

const OUT = process.env.TESTIVAI_ANDROID_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-android-out-'));
const CLI = path.join(path.dirname(require.resolve('@testivai/witness')), 'bin', 'testivai.js');

const summary: Record<string, unknown> = { steps: [] as unknown[] };
const steps = summary.steps as unknown[];
const { expect, failures } = checklist('android');

/**
 * The bottom of the status bar's frame in a `mobile: getSystemBars` answer
 * (`{ statusBar: { visible, x, y, width, height } }`), read here without the
 * adapter's code; 0 when there is no visible bar.
 */
function barBottom(bars: unknown): number {
  const bar = (bars as { statusBar?: { visible?: boolean; y?: unknown; height?: unknown } } | null)?.statusBar;
  return bar && bar.visible !== false && typeof bar.y === 'number' && typeof bar.height === 'number' ? bar.y + bar.height : 0;
}

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
    // Two readings of the status bar: UiAutomator2's, from the session start
    // (mobile: viewportRect gives it back all session), and the window manager's now.
    const viewportRect = (await session.execute('mobile: viewportRect')) as { top: number };
    const sessionStart = viewportRect.top;
    const portraitBars = await session.execute('mobile: getSystemBars');
    const statusBar = barBottom(portraitBars);
    // The key the adapter should use, read from the capabilities here.
    const model = String(caps.deviceModel ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const osMajor = String(caps.platformVersion ?? '').split('.')[0];
    const keyed = (base: string) => `${base}__android-${model}-${osMajor}`;
    const NAME = keyed('settings');
    summary.expected = { name: NAME, statusBar, sessionStart, statBarHeight: caps.statBarHeight, systemBars: portraitBars };
    console.log(`[android] device ${JSON.stringify({ model: caps.deviceModel, platformVersion: caps.platformVersion, viewportRect })}; expecting ${NAME}`);
    console.log(
      `[android] status bar: window manager ${statusBar} px (mobile: getSystemBars), UiAutomator2 ${sessionStart} px (read at the session start)` +
        (statusBar !== sessionStart ? ' — they differ in this run' : ''),
    );
    expect(statusBar > 0, `fixture: the window manager reports a visible status bar — ${JSON.stringify(portraitBars)}`);

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
    fs.mkdirSync(path.join(OUT, 'steps'), { recursive: true });
    const pngs: Record<string, PNG> = {};
    const capture = async (step: string, base = 'settings') => {
      const name = keyed(base);
      const tempDir = path.join(root, '.testivai', 'temp', name);
      await sleep(2000);
      const front = await appInFront(session, 'com.android.settings', 'com.android.settings/.Settings', step);
      scripts.length = 0;
      const retriesBefore = retries;
      const started = Date.now();
      await witness(browser as unknown as Parameters<typeof witness>[0], base);
      const ms = Date.now() - started;
      if (!fs.existsSync(tempDir)) {
        const written = fs.existsSync(path.dirname(tempDir)) ? fs.readdirSync(path.dirname(tempDir)) : [];
        throw new Error(`${step}: native mode did not key the capture as ${name}; temp has ${JSON.stringify(written)}`);
      }
      const files = fs.readdirSync(tempDir).sort();
      const png = PNG.sync.read(fs.readFileSync(path.join(tempDir, 'screenshot.png')));
      const key = step.split('.')[0];
      pngs[key] = png;
      fs.copyFileSync(path.join(tempDir, 'screenshot.png'), path.join(OUT, 'steps', `${key}.png`));
      const luma = Math.round(meanLuma(png, statusBar));
      const metadata = JSON.parse(fs.readFileSync(path.join(tempDir, 'metadata.json'), 'utf-8'));
      const record = {
        step,
        focus: front.focus,
        actionsBefore: front.actions,
        luma,
        witnessMs: ms,
        files,
        screenshot: `${png.width}x${png.height}`,
        landscape: png.width > png.height,
        scripts: [...scripts],
        retries: retries - retriesBefore,
        metadata,
      };
      steps.push(record);
      console.log(`[android] ${step}: witness ${ms} ms, files ${files.join(', ')}, ${record.screenshot}, mean luma ${luma}, scripts ${JSON.stringify(record.scripts)}, retries ${record.retries}`);
      console.log(`[android]     in front: ${front.focus}${front.actions.length ? ` (after: ${front.actions.join('; ')})` : ''}`);
      return record;
    };
    const report = (name = NAME) => {
      const s = generateReport({ projectRoot: root, autoOpen: false }).snapshots.find((x) => x.name === name);
      assert.ok(s, `no result for ${name}`);
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
    expect(
      JSON.stringify(first.scripts) === JSON.stringify(['mobile: getSystemBars']),
      `1. the status bar comes from the window manager: one mobile: getSystemBars call, no fallback — ${JSON.stringify(first.scripts)}`,
    );
    expect(
      JSON.stringify(first.metadata.masks) === JSON.stringify([{ top: statusBar }]),
      `1. the status bar is masked to the window manager's bar: masks ${JSON.stringify(first.metadata.masks)}, bar ${statusBar} px`,
    );

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
    const clockRow = lastDifferingRow(pngs['2'], pngs['3']);
    summary.clockChange = { ...moved, statusBar, lastRow: clockRow };
    expect(moved.above > 0, `fixture: the clock change is in the screenshots — ${moved.above} px differ in the status bar, ${moved.below} below it`);
    expect(clockRow >= 0 && clockRow < statusBar, `3. the window manager's bar covers the clock — last changed row ${clockRow}, bar ${statusBar} px`);
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
    store.clearTemp();

    // 5. Landscape, after the session started.
    adb('shell', 'cmd', 'uimode', 'night', 'no');
    demo('clock', '-e', 'hhmm', '1200');
    await rotateAndWait(1);
    await sleep(1000); // the system bars settle after the turn
    const landscapeBars = await session.execute('mobile: getSystemBars');
    const landscapeBar = barBottom(landscapeBars);
    const laterTop = ((await session.execute('mobile: viewportRect')) as { top: number }).top;
    summary.landscape = { systemBars: landscapeBars, statusBar: landscapeBar, viewportRectTop: laterTop };
    console.log(`[android] landscape status bar: window manager ${landscapeBar} px, UiAutomator2 ${laterTop} px`);
    const LANDSCAPE = keyed('settings-landscape');
    const wide = await capture('5. landscape', 'settings-landscape');
    expect(wide.landscape, `fixture: the capture is landscape — ${wide.screenshot}`);
    expect(landscapeBar > 0 && landscapeBar !== statusBar, `fixture: the turn changed the status bar — portrait ${statusBar} px, landscape ${landscapeBar} px`);
    expect(laterTop === sessionStart, `fixture: UiAutomator2's reading stayed at the session start — mobile: viewportRect top ${laterTop} px`);
    expect(
      JSON.stringify(wide.metadata.masks) === JSON.stringify([{ top: landscapeBar }]),
      `5. the mask follows the turn: masks ${JSON.stringify(wide.metadata.masks)}, landscape bar ${landscapeBar} px`,
    );
    expect(report(LANDSCAPE).status === 'new', `5. the landscape screen is its own snapshot, ${LANDSCAPE}, status "new"`);
    const approveWide = spawnSync(process.execPath, [CLI, 'approve', '--all'], { cwd: root, encoding: 'utf-8' });
    expect(approveWide.status === 0 && store.exists(LANDSCAPE), `5. testivai approve --all approves it — exit ${approveWide.status}`);
    store.clearTemp();

    // 6. The clock moves in landscape.
    demo('clock', '-e', 'hhmm', '1201');
    await capture('6. landscape clock 12:01', 'settings-landscape');
    const movedWide = differingPixels(pngs['5'], pngs['6'], landscapeBar);
    const wideRow = lastDifferingRow(pngs['5'], pngs['6']);
    summary.landscapeClockChange = { ...movedWide, statusBar: landscapeBar, lastRow: wideRow };
    expect(movedWide.above > 0, `fixture: the clock change is in the landscape screenshots — ${movedWide.above} px differ in the bar, ${movedWide.below} below it`);
    expect(wideRow >= 0 && wideRow < landscapeBar, `6. the window manager's landscape bar covers the clock — last changed row ${wideRow}, bar ${landscapeBar} px`);
    const wideClock = report(LANDSCAPE);
    expect(wideClock.status === 'passed' && wideClock.diffCount === 0, `6. a clock change in landscape passes with the automatic mask alone — ${wideClock.status}, ${wideClock.diffCount} px`);
    fs.cpSync(path.join(root, 'visual-report'), path.join(OUT, 'visual-report-landscape'), { recursive: true });
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
