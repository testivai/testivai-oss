/**
 * Native app captures (experimental): what an Appium session's capabilities
 * say about the device a native screen was captured on.
 *
 * A native screen has no page, so nothing is measured in it: the device, its
 * OS, its screen and the status bar come from the capabilities. Appium answers
 * a new session with unprefixed keys (`platformVersion`, `deviceModel`) and
 * keeps what was asked for under `desired`; a session started with W3C keys
 * has them prefixed (`appium:deviceName`). Every reader here accepts both.
 * Whatever the capabilities do not say is left out, never guessed.
 *
 * The Android readings are what Appium 3.9 + UiAutomator2 8.7 returned on an
 * Android 14 emulator; the iOS ones follow XCUITest's documented
 * capabilities and are not verified on a simulator in this repository's CI.
 */

import {
  buildCaptureEnvironment,
  type CaptureEnvironment,
  collectHostEnvironment,
  type DeviceEnvironment,
  type HostEnvironment,
} from './environment';

type Caps = Record<string, unknown>;

const asRecord = (v: unknown): Caps | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Caps) : null);

/** A capability as the session returned it, else as it was asked for. */
function returned(caps: Caps, key: string): unknown {
  return caps[key] ?? caps[`appium:${key}`];
}

function requested(caps: Caps, key: string): unknown {
  const desired = asRecord(caps.desired);
  return desired?.[key] ?? desired?.[`appium:${key}`] ?? caps[`appium:${key}`];
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);

function positive(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** android / ios, or null for anything else (a desktop browser, no capabilities). */
export function mobilePlatform(capabilities: unknown): 'android' | 'ios' | null {
  const caps = asRecord(capabilities);
  const name = caps ? text(returned(caps, 'platformName'))?.toLowerCase() : undefined;
  return name === 'android' || name === 'ios' ? name : null;
}

/** Whether the session names a browser (a mobile or desktop browser session). */
export function namesBrowser(capabilities: unknown): boolean {
  const caps = asRecord(capabilities);
  return Boolean(caps && text(caps.browserName));
}

/**
 * An Appium session started on an app: Android or iOS, no browser, and an
 * `app`, `appPackage` or `bundleId`. A mobile session that names neither is
 * decided by its current context (the adapter asks).
 */
export function isNativeAppCapabilities(capabilities: unknown): boolean {
  const caps = asRecord(capabilities);
  if (!caps || !mobilePlatform(caps) || namesBrowser(caps)) return false;
  return ['app', 'appPackage', 'bundleId'].some((key) => text(returned(caps, key)) !== undefined);
}

/**
 * The device from the capabilities. The name is the one the session asked for:
 * on Android, Appium puts the device serial (`emulator-5554`) in the
 * deviceName it returns.
 */
export function nativeAppDevice(capabilities: unknown): DeviceEnvironment {
  const caps = asRecord(capabilities) ?? {};
  const platform = mobilePlatform(caps) ?? 'unknown';
  const device: DeviceEnvironment = { platform };
  const osVersion = text(returned(caps, 'platformVersion'));
  if (osVersion) device.osVersion = osVersion;
  const model = text(returned(caps, 'deviceModel'));
  if (model) device.model = model;
  const name = text(requested(caps, 'deviceName')) ?? (platform === 'ios' ? text(returned(caps, 'deviceName')) : undefined);
  if (name) device.name = name;
  const automation = text(returned(caps, 'automationName'));
  if (automation) device.automation = automation;
  const screen = text(returned(caps, 'deviceScreenSize'));
  if (screen && /^\d+x\d+$/.test(screen)) device.screen = screen;
  const density = positive(returned(caps, 'deviceScreenDensity'));
  if (density) device.density = density;
  return device;
}

/** Lowercase, every run of other characters one `_`, none leading or trailing. */
function segment(s: string): string {
  let out = s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  // Runs are collapsed above, so at most one `_` sits at either end.
  if (out.startsWith('_')) out = out.slice(1);
  if (out.endsWith('_')) out = out.slice(0, -1);
  return out;
}

/**
 * The snapshot key for a device, `<platform>-<device>-<osMajor>`: the model
 * the device reports, else the name the session asked for, and the OS major
 * version. A part the capabilities do not give is left out.
 */
export function nativeAppVariant(device: DeviceEnvironment): string {
  const who = device.model ?? device.name;
  const major = device.osVersion?.split('.')[0];
  return [device.platform, who, major]
    .filter((p): p is string => Boolean(p))
    .map(segment)
    .filter((p) => p.length > 0)
    .join('-');
}

/**
 * The status bar's height in screenshot pixels from the session's
 * capabilities (UiAutomator2 returns `viewportRect` and `statBarHeight`), or
 * null. The adapters prefer `mobile: viewportRect`, measured at capture time.
 */
export function statusBarFromCapabilities(capabilities: unknown): number | null {
  const caps = asRecord(capabilities) ?? {};
  return statusBarFromViewportRect(returned(caps, 'viewportRect')) ?? positive(returned(caps, 'statBarHeight')) ?? null;
}

/** The top of a viewport rectangle (`mobile: viewportRect`), or null. */
export function statusBarFromViewportRect(rect: unknown): number | null {
  const top = asRecord(rect)?.top;
  return typeof top === 'number' && Number.isFinite(top) && top > 0 ? Math.round(top) : null;
}

export interface AppiumEnvironmentInput {
  capabilities: unknown;
  adapter: CaptureEnvironment['adapter'];
  framework: { name: string; version: string | null };
  host?: HostEnvironment;
}

/**
 * The environment block of a native app capture: the machine the tests ran on
 * (`os`), `browser.name: "native-app"` so every reader of the contract still
 * reads it, the device, and the pixel ratio as the device scale.
 */
export function appiumEnvironment(input: AppiumEnvironmentInput): CaptureEnvironment {
  const caps = asRecord(input.capabilities) ?? {};
  const scale = positive(returned(caps, 'pixelRatio'));
  return buildCaptureEnvironment({
    host: input.host ?? collectHostEnvironment(),
    browser: { name: 'native-app', version: null },
    framework: { ...input.framework },
    adapter: input.adapter,
    render: scale ? { deviceScaleFactor: scale } : undefined,
    device: nativeAppDevice(caps),
  });
}
