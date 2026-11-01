/**
 * Mobile plan, Track 1 Level 0: today's WebdriverIO adapter, unmodified,
 * against a real Android emulator (Appium 3 + UiAutomator2). No product code
 * is changed; this checks the plan's simulation against the real thing.
 *
 * The simulation (a fake driver with Android native capabilities) said:
 *   1. witness() captures a native screen: status "new", and only
 *      screenshot.png is written. The adapter's five page-script calls
 *      (render probe, CSS injection, font wait, DOM, element map) are
 *      rejected in native mode and caught.
 *   2. The same screen again: passed.
 *   3. Only the status-bar clock moved: "changed", the change in the status
 *      bar; with "mask": [{ "top": <status bar height> }] in config.json it
 *      passes.
 *   4. A visible change (here: dark mode): "changed", and
 *      `testivai report --fail-on-diff` exits 1.
 *   5. No environment block is written (a native session has no browser
 *      name).
 *
 * The screen is checked too, before trusting any of that: Settings must be
 * the focused window before every capture (a "not responding" dialog left by
 * a slow boot is dismissed), the first capture must be light and the
 * dark-mode capture dark (`cmd uimode night` and the pixels). A run
 * that captured something else fails as a fixture problem, not as a match.
 * Every step's screenshot is kept in $TESTIVAI_ANDROID_OUT/steps.
 *
 * It also records what the simulation could not know: how long each rejected
 * page script took, how often WebdriverIO resent it (it retries a command
 * after any error response), how long Appium itself takes to reject one (a
 * raw request, no client retries), what the rejection said, the screenshot
 * size and the status bar height. Everything is written to $TESTIVAI_ANDROID_OUT
 * (summary.json, the visual report) and printed.
 *
 * Runs in .github/workflows/android-native.yml, inside
 * reactivecircus/android-emulator-runner, with Appium on 127.0.0.1:4723 and
 * adb on PATH. The app is Android's own Settings, so no APK is needed. Not
 * part of `pnpm e2e`: it needs an emulator.
 */

import * as assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { remote } from 'webdriverio';

import { BaselineStore, generateReport } from '@testivai/witness';
import { witness } from '@testivai/witness-webdriverio';

const OUT = process.env.TESTIVAI_ANDROID_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-android-out-'));
const CLI = path.join(path.dirname(require.resolve('@testivai/witness')), 'bin', 'testivai.js');
const NAME = 'settings';

interface ScriptCall {
  script: string;
  ms: number;
  ok: boolean;
  /** Times WebdriverIO resent the command after an error response. */
  retries: number;
  error?: string;
}

const summary: Record<string, unknown> = { steps: [] as unknown[] };
const steps = summary.steps as unknown[];
const failures: string[] = [];

// The simulation's clock change read ~0.003%; the real figure is recorded
// (summary.clockChange) and reported, not gated.

function adb(...args: string[]): string {
  return execFileSync('adb', args, { encoding: 'utf-8' }).trim();
}

function demo(command: string, ...extras: string[]): void {
  adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', command, ...extras);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Name a page script by what it does, for the summary. */
function label(script: string): string {
  if (script.startsWith('mobile:')) return script;
  if (script.includes('prefers-color-scheme')) return 'render probe';
  if (script.includes("createElement('style')")) return 'inject capture CSS';
  if (script.includes('document.fonts')) return 'font wait';
  if (script.includes('cloneNode')) return 'DOM';
  if (script.includes('collectElementMap')) return 'element map';
  if (script.includes('getElementById') && script.includes('remove')) return 'remove capture CSS';
  return script.slice(0, 40);
}

/** The focused window, as `dumpsys window` names it. */
function focusedWindow(): string {
  const line = adb('shell', 'dumpsys', 'window')
    .split('\n')
    .find((l) => l.includes('mCurrentFocus='));
  return (line ?? '').trim();
}

/** Mean luma (0–255) of a capture below the status bar. */
function meanLuma(png: PNG, top: number): number {
  let sum = 0;
  let n = 0;
  for (let y = top; y < png.height; y += 4) {
    for (let x = 0; x < png.width; x += 4) {
      const i = (y * png.width + x) * 4;
      sum += 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
      n++;
    }
  }
  return n ? sum / n : 0;
}

function expect(condition: boolean, what: string): void {
  if (!condition) failures.push(what);
  console.log(`[android] ${condition ? '✓' : '✗'} ${what}`);
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testivai-android-'));
  fs.mkdirSync(path.join(root, '.testivai'), { recursive: true });
  const writeConfig = (extra: object) =>
    fs.writeFileSync(path.join(root, '.testivai', 'config.json'), JSON.stringify({ autoOpen: false, ...extra }));
  writeConfig({});
  process.chdir(root);

  // No new crash or "not responding" dialogs over the app (a slow CI boot
  // leaves the launcher not responding), then freeze the status bar with
  // demo mode, clock at 12:00.
  adb('shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1');
  adb('shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1');
  demo('enter');
  demo('clock', '-e', 'hhmm', '1200');
  demo('notifications', '-e', 'visible', 'false');
  demo('battery', '-e', 'level', '100', '-e', 'plugged', 'false');
  demo('network', '-e', 'wifi', 'show', '-e', 'level', '4');
  adb('shell', 'cmd', 'uimode', 'night', 'no');

  const session = await remote({
    hostname: '127.0.0.1',
    port: 4723,
    path: '/',
    // Every rejection is recorded below; WebdriverIO's own warnings would
    // repeat each one per retry.
    logLevel: 'silent',
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
    summary.capabilities = session.capabilities;
    const viewportRect = (await session.execute('mobile: viewportRect')) as { left: number; top: number; width: number; height: number };
    summary.viewportRect = viewportRect;
    const statusBar = viewportRect.top;
    console.log(`[android] device ${JSON.stringify({ ...(session.capabilities as object), viewportRect })}`);

    // How long Appium itself takes to reject a page script: raw requests,
    // outside WebdriverIO, so no client retries.
    const direct: Array<{ ms: number; status: number; error: unknown }> = [];
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:4723/session/${session.sessionId}/execute/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: 'return document.title', args: [] }),
      });
      const body = (await res.json().catch(() => null)) as { value?: { error?: unknown; message?: unknown } } | null;
      direct.push({ ms: Date.now() - started, status: res.status, error: body?.value?.error ?? body?.value?.message ?? null });
    }
    summary.directRejection = direct;
    console.log(`[android] Appium's own rejection of a page script (no client retries): ${JSON.stringify(direct)}`);
    let retries = 0;
    session.on('request.retry', () => {
      retries++;
    });

    // The adapter's browser, with every page script timed.
    const calls: ScriptCall[] = [];
    const browser = {
      capabilities: session.capabilities as Record<string, unknown>,
      takeScreenshot: () => session.takeScreenshot(),
      execute: async (script: unknown, ...args: unknown[]) => {
        const started = Date.now();
        const retriesBefore = retries;
        const name = label(String(script));
        try {
          const result = await (session.execute as (s: unknown, ...a: unknown[]) => Promise<unknown>)(script, ...args);
          calls.push({ script: name, ms: Date.now() - started, ok: true, retries: retries - retriesBefore });
          return result;
        } catch (err) {
          calls.push({ script: name, ms: Date.now() - started, ok: false, retries: retries - retriesBefore, error: String((err as Error).message).split('\n')[0].slice(0, 200) });
          throw err;
        }
      },
    };

    // Settings in front, or the run says nothing: dismiss a "not
    // responding" dialog (its Wait button), else open Settings again.
    const settingsInFront = async (step: string) => {
      const actions: string[] = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const focus = focusedWindow();
        if (focus.includes('com.android.settings/')) return { focus, actions };
        if (/Not Responding/i.test(focus)) {
          try {
            const wait = await session.findElement('-android uiautomator', 'new UiSelector().text("Wait")');
            await session.elementClick(Object.values(wait as Record<string, string>)[0]);
            actions.push(`tapped Wait on: ${focus}`);
          } catch {
            adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
            actions.push(`pressed Back on: ${focus}`);
          }
        } else {
          adb('shell', 'am', 'start', '-W', '-n', 'com.android.settings/.Settings');
          actions.push(`opened Settings over: ${focus}`);
        }
        await sleep(2000);
      }
      throw new Error(`fixture: ${step}: Settings is not the focused window (${focusedWindow()}); actions: ${actions.join('; ')}`);
    };

    const store = new BaselineStore(root);
    const tempDir = path.join(root, '.testivai', 'temp', NAME);
    fs.mkdirSync(path.join(OUT, 'steps'), { recursive: true });
    const capture = async (step: string) => {
      calls.length = 0;
      await sleep(2000);
      const front = await settingsInFront(step);
      const started = Date.now();
      await witness(browser as unknown as Parameters<typeof witness>[0], NAME);
      const ms = Date.now() - started;
      const files = fs.readdirSync(tempDir).sort();
      const png = PNG.sync.read(fs.readFileSync(path.join(tempDir, 'screenshot.png')));
      fs.copyFileSync(path.join(tempDir, 'screenshot.png'), path.join(OUT, 'steps', `${step.split('.')[0]}.png`));
      const luma = Math.round(meanLuma(png, statusBar));
      const record = { step, focus: front.focus, actionsBefore: front.actions, luma, witnessMs: ms, files, screenshot: `${png.width}x${png.height}`, scriptCalls: [...calls] };
      steps.push(record);
      console.log(`[android] ${step}: witness ${ms} ms, files ${files.join(', ')}, ${record.screenshot}, mean luma ${luma}`);
      console.log(`[android]     in front: ${front.focus}${front.actions.length ? ` (after: ${front.actions.join('; ')})` : ''}`);
      for (const c of calls) console.log(`[android]     ${c.ok ? 'ok    ' : 'failed'} ${String(c.ms).padStart(5)} ms  ${c.retries} retries  ${c.script}${c.error ? `  (${c.error})` : ''}`);
      return record;
    };
    const report = () => {
      const s = generateReport({ projectRoot: root, autoOpen: false }).snapshots.find((x) => x.name === NAME);
      assert.ok(s, 'no result for the snapshot');
      console.log(`[android]     ${s.status} ${s.diffPercent.toFixed(4)}% (${s.diffCount} px), regions ${JSON.stringify((s.regions ?? []).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })))}`);
      return s;
    };

    // 1. First capture.
    const first = await capture('1. first capture');
    expect(first.luma >= 160, `fixture: the light Settings screen is light — mean luma ${first.luma}`);
    expect(report().status === 'new', '1. a native screen is captured, status "new"');
    expect(first.files.includes('screenshot.png'), '1. screenshot.png is written');
    expect(first.files.join(',') === 'screenshot.png', `1. only screenshot.png is written (simulation) — got ${first.files.join(', ')}`);
    const failed = first.scriptCalls.filter((c) => !c.ok);
    expect(first.scriptCalls.length === 5 && failed.length === 5, `1. the five page scripts are rejected and caught (simulation) — ${failed.length} of ${first.scriptCalls.length} failed`);
    expect(!fs.existsSync(path.join(tempDir, 'metadata.json')), '5. no environment block is written (simulation)');
    const slowest = Math.max(...first.scriptCalls.map((c) => c.ms));
    summary.slowestRejectedScriptMs = slowest;
    console.log(`[android]     slowest rejected page script: ${slowest} ms`);

    // Approve with the CLI, as a user would.
    const approve = spawnSync(process.execPath, [CLI, 'approve', '--all'], { cwd: root, encoding: 'utf-8' });
    expect(approve.status === 0 && store.exists(NAME), `1. testivai approve --all approves it — exit ${approve.status}`);
    store.clearTemp();

    // 2. The same screen.
    await capture('2. same screen');
    const same = report();
    expect(same.status === 'passed', `2. the same screen passes — ${same.status}, ${same.diffCount} px`);
    store.clearTemp();

    // 3. Only the clock moves.
    demo('clock', '-e', 'hhmm', '1201');
    await capture('3. clock 12:01');
    const clock = report();
    summary.clockChange = { diffPercent: clock.diffPercent, diffCount: clock.diffCount, statusBar, regions: clock.regions ?? [] };
    const inStatusBar = (clock.regions ?? []).every((r) => r.y + r.height <= statusBar);
    expect(clock.status === 'changed', `3. a clock change is a change — ${clock.status}`);
    expect((clock.regions ?? []).length > 0 && inStatusBar, `3. every change region is inside the status bar (top ${statusBar} px)`);
    writeConfig({ mask: [{ top: statusBar }] });
    const masked = report();
    expect(masked.status === 'passed', `3. with "mask": [{ "top": ${statusBar} }] it passes — ${masked.status}`);
    store.clearTemp();

    // 4. A visible change: dark mode, with the status-bar mask still on.
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
    try {
      adb('shell', 'cmd', 'uimode', 'night', 'no');
      demo('exit');
    } catch {
      // the emulator is thrown away anyway
    }
    await session.deleteSession().catch(() => {});
    summary.failures = failures;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`[android] summary written to ${path.join(OUT, 'summary.json')}`);
  }

  assert.deepStrictEqual(failures, [], 'the real run does not match the simulation');
  console.log('[android] ✓ The real Android run matches the simulation.');
}

main().catch((err) => {
  console.error('[android] ✗ Level 0 check failed');
  console.error(err);
  process.exit(1);
});
