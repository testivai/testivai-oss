/**
 * What the Android emulator checks share (android-native.ts,
 * android-webview.ts): adb, demo mode, the focused window, keeping the app
 * under test in front, and a pass/fail list that prints as it goes.
 */

import { execFileSync } from 'child_process';
import type { PNG } from 'pngjs';

export function adb(...args: string[]): string {
  return execFileSync('adb', args, { encoding: 'utf-8' }).trim();
}

export function demo(command: string, ...extras: string[]): void {
  adb('shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', command, ...extras);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Google Play Services disabled (see disablePlayServices), no new crash or "not responding" dialogs over the app (a slow CI boot
 * leaves the launcher not responding), light mode, and the status bar frozen
 * with demo mode, clock at 12:00.
 */
const PLAY_SERVICES = 'com.google.android.gms';

/**
 * Disables Google Play Services on the throwaway emulator, before any app
 * under test starts. On the google_apis image it applies a module update
 * about two minutes after boot and kills its own processes to restart
 * ("Module config changed, forcing restart"); Android then kills every app
 * using one of its providers. The WebView fixture uses its FontsProvider, so
 * the app and its WebView renderer died at whatever step was running (#266,
 * #270). Disabled, nothing depends on it and the WebView uses system fonts.
 */
export function disablePlayServices(): 'disabled' | 'not installed' {
  const installed = adb('shell', 'pm', 'list', 'packages', PLAY_SERVICES)
    .split('\n')
    .some((l) => l.trim() === `package:${PLAY_SERVICES}`);
  if (!installed) return 'not installed';
  adb('shell', 'pm', 'disable-user', '--user', '0', PLAY_SERVICES);
  const disabled = adb('shell', 'pm', 'list', 'packages', '-d', PLAY_SERVICES)
    .split('\n')
    .some((l) => l.trim() === `package:${PLAY_SERVICES}`);
  if (!disabled) throw new Error(`fixture: Google Play Services is still enabled after pm disable-user ${PLAY_SERVICES}`);
  return 'disabled';
}

export function prepareDevice(): void {
  // Before Play Services goes: with it disabled, apps post an "Enable Google
  // Play services" heads-up notification over the screen under test.
  adb('shell', 'settings', 'put', 'global', 'heads_up_notifications_enabled', '0');
  console.log(`[device] Google Play Services: ${disablePlayServices()}`);
  adb('shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1');
  adb('shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1');
  demo('enter');
  demo('clock', '-e', 'hhmm', '1200');
  demo('notifications', '-e', 'visible', 'false');
  demo('battery', '-e', 'level', '100', '-e', 'plugged', 'false');
  demo('network', '-e', 'wifi', 'show', '-e', 'level', '4');
  adb('shell', 'cmd', 'uimode', 'night', 'no');
}

/**
 * Turn the display: 0 portrait, 1 landscape (a quarter turn). Auto-rotate is
 * switched off first, so the device keeps the turn it is given.
 */
export function rotate(quarterTurns: 0 | 1 | 2 | 3): void {
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', String(quarterTurns));
}

/** The screen's size now, read from a screencap's PNG header (IHDR width and height). */
function screenSize(): { width: number; height: number } {
  const png = execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Turns the display and waits until the screen really is that way round. A
 * fixed sleep was not enough on a slow runner: right after `uimode night no`
 * restarts Settings, the turn could take longer than 3 s and the capture was
 * still portrait. Asks once more halfway; throws after `timeoutMs`.
 */
export async function rotateAndWait(
  quarterTurns: 0 | 1 | 2 | 3,
  { timeoutMs = 20_000, pollMs = 500 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const wantLandscape = quarterTurns % 2 === 1;
  rotate(quarterTurns);
  const start = Date.now();
  let askedAgain = false;
  for (;;) {
    const { width, height } = screenSize();
    if (width > height === wantLandscape) return;
    const waited = Date.now() - start;
    if (waited > timeoutMs) throw new Error(`the display did not turn: ${width}x${height} after ${waited} ms`);
    if (!askedAgain && waited > timeoutMs / 2) {
      rotate(quarterTurns);
      askedAgain = true;
    }
    await sleep(pollMs);
  }
}

export function restoreDevice(): void {
  try {
    rotate(0);
    adb('shell', 'cmd', 'uimode', 'night', 'no');
    demo('exit');
  } catch {
    // the emulator is thrown away anyway
  }
}

/**
 * The focused window now. `dumpsys window displays`, not the full dump: that
 * one starts with the window state frozen at the last ANR (a slow boot leaves
 * the launcher's), so its first mCurrentFocus can be stale.
 */
export function focusedWindow(): string {
  const line = adb('shell', 'dumpsys', 'window', 'displays')
    .split('\n')
    .find((l) => l.includes('mCurrentFocus='));
  return (line ?? '').trim();
}

/** The bits of a WebdriverIO session the helpers use. */
export interface AppiumSession {
  findElement(using: string, value: string): Promise<unknown>;
  elementClick(id: string): Promise<unknown>;
}

/**
 * The app in front, or the run says nothing: a "not responding" dialog is
 * dismissed (its Wait button), else the app is opened again (`component`, as
 * `am start -n` takes it), at most five times. Returns what was done.
 */
export async function appInFront(
  session: AppiumSession,
  appPackage: string,
  component: string,
  step: string,
): Promise<{ focus: string; actions: string[] }> {
  const actions: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const focus = focusedWindow();
    if (focus.includes(`${appPackage}/`)) return { focus, actions };
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
      adb('shell', 'am', 'start', '-W', '-n', component);
      actions.push(`opened ${appPackage} over: ${focus}`);
    }
    await sleep(2000);
  }
  throw new Error(`fixture: ${step}: ${appPackage} is not the focused window (${focusedWindow()}); actions: ${actions.join('; ')}`);
}

/** Mean luma (0–255) of a capture below a row. */
export function meanLuma(png: PNG, top: number): number {
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

/** Pixels that differ between two same-size captures, above and below a row. */
export function differingPixels(a: PNG, b: PNG, splitY: number): { above: number; below: number } {
  const out = { above: 0, below: 0 };
  if (a.width !== b.width || a.height !== b.height) return { above: -1, below: -1 };
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
      if (Math.floor(i / 4 / a.width) < splitY) out.above++;
      else out.below++;
    }
  }
  return out;
}

/** The lowest row (0-based) where two same-size captures differ, or -1 when none does. */
export function lastDifferingRow(a: PNG, b: PNG): number {
  if (a.width !== b.width || a.height !== b.height) return -1;
  for (let y = a.height - 1; y >= 0; y--) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) return y;
    }
  }
  return -1;
}

/** Expectations that print as they go and are asserted together at the end. */
export function checklist(tag: string): { expect(condition: boolean, what: string): void; failures: string[] } {
  const failures: string[] = [];
  return {
    failures,
    expect(condition: boolean, what: string) {
      if (!condition) failures.push(what);
      console.log(`[${tag}] ${condition ? '✓' : '✗'} ${what}`);
    },
  };
}
