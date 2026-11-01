/**
 * Native app captures (Appium): what a session's capabilities say about the
 * device, the environment block they record, the snapshot key, and how a
 * change of device reads in the report.
 *
 * The Android capabilities are the ones Appium 3.9 + UiAutomator2 8.7 returned
 * for the Settings app on an Android 14 emulator (e2e/src/android-native.ts).
 * The iOS ones are what an XCUITest session is started with; the iOS side is
 * not verified on a real simulator here.
 */
import type { CaptureEnvironment, HostEnvironment } from '../capture/environment';
import { CAPTURE_METHODS } from '../capture/environment';
import {
  appiumEnvironment,
  isNativeAppCapabilities,
  nativeAppDevice,
  nativeAppVariant,
  statusBarFromCapabilities,
} from '../capture/native-app';
import { describeCaptureMethod, describeEnvironmentChange, diffEnvironments } from '../report/environment';

/** As WebdriverIO's browser.capabilities holds them: Appium's answer, unprefixed. */
const ANDROID_CAPS = {
  platformName: 'Android',
  automationName: 'UiAutomator2',
  appPackage: 'com.android.settings',
  appActivity: '.Settings',
  noReset: true,
  platform: 'LINUX',
  takesScreenshot: true,
  desired: {
    platformName: 'Android',
    automationName: 'UiAutomator2',
    appPackage: 'com.android.settings',
    appActivity: '.Settings',
  },
  deviceName: 'emulator-5554',
  deviceUDID: 'emulator-5554',
  pixelRatio: '2.625',
  statBarHeight: 136,
  viewportRect: { left: 0, top: 136, width: 1080, height: 2264 },
  deviceApiLevel: 34,
  platformVersion: '14',
  deviceManufacturer: 'Google',
  deviceModel: 'sdk_gphone64_x86_64',
  deviceScreenSize: '1080x2400',
  deviceScreenDensity: 420,
};

/** An XCUITest session as requested (W3C `appium:` prefixes). */
const IOS_CAPS = {
  platformName: 'iOS',
  'appium:automationName': 'XCUITest',
  'appium:deviceName': 'iPhone 15',
  'appium:platformVersion': '17.5',
  'appium:bundleId': 'com.example.app',
};

const HOST: HostEnvironment = { os: { platform: 'linux', release: '6.8.0', arch: 'x64', distro: 'ubuntu 24.04' } };
const ADAPTER = { name: '@testivai/witness-webdriverio', version: '2.1.0', captureMethod: CAPTURE_METHODS.APPIUM_SCREEN };
const FRAMEWORK = { name: 'webdriverio', version: '9.31.7' };

describe('isNativeAppCapabilities', () => {
  it('is true for an Android app session (appPackage) and an iOS app session (bundleId)', () => {
    expect(isNativeAppCapabilities(ANDROID_CAPS)).toBe(true);
    expect(isNativeAppCapabilities(IOS_CAPS)).toBe(true);
    expect(isNativeAppCapabilities({ platformName: 'Android', 'appium:app': '/apps/demo.apk' })).toBe(true);
  });

  it('is false for a mobile browser session, a desktop browser and no capabilities', () => {
    expect(isNativeAppCapabilities({ platformName: 'Android', browserName: 'chrome', 'appium:automationName': 'UiAutomator2' })).toBe(false);
    expect(isNativeAppCapabilities({ platformName: 'iOS', browserName: 'Safari' })).toBe(false);
    expect(isNativeAppCapabilities({ browserName: 'chrome', platformName: 'linux' })).toBe(false);
    expect(isNativeAppCapabilities(undefined)).toBe(false);
  });

  it('is false for a mobile session that names no app (the context decides: the adapter asks)', () => {
    expect(isNativeAppCapabilities({ platformName: 'Android', 'appium:automationName': 'UiAutomator2' })).toBe(false);
  });
});

describe('nativeAppDevice', () => {
  it('reads the Android device from what Appium returned', () => {
    expect(nativeAppDevice(ANDROID_CAPS)).toEqual({
      platform: 'android',
      osVersion: '14',
      model: 'sdk_gphone64_x86_64',
      automation: 'UiAutomator2',
      screen: '1080x2400',
      density: 420,
    });
  });

  it('takes the device name the session asked for, never the serial Appium puts in deviceName', () => {
    const caps = { ...ANDROID_CAPS, desired: { ...ANDROID_CAPS.desired, deviceName: 'Pixel 7' } };
    expect(nativeAppDevice(caps).name).toBe('Pixel 7');
    expect(nativeAppDevice(ANDROID_CAPS).name).toBeUndefined();
  });

  it('reads an iOS device from appium:-prefixed capabilities', () => {
    expect(nativeAppDevice(IOS_CAPS)).toEqual({ platform: 'ios', osVersion: '17.5', name: 'iPhone 15', automation: 'XCUITest' });
  });
});

describe('nativeAppVariant', () => {
  it('is <platform>-<device>-<osMajor>, the model first, sanitized', () => {
    expect(nativeAppVariant(nativeAppDevice(ANDROID_CAPS))).toBe('android-sdk_gphone64_x86_64-14');
    expect(nativeAppVariant(nativeAppDevice(IOS_CAPS))).toBe('ios-iphone_15-17');
    expect(nativeAppVariant({ platform: 'android', osVersion: '15', model: 'Pixel 7' })).toBe('android-pixel_7-15');
  });

  it('separators collapse to one underscore and never lead or trail a part, even for long runs', () => {
    expect(nativeAppVariant({ platform: 'android', model: '__Pixel  7 (5G)__', osVersion: '15' })).toBe('android-pixel_7_5g-15');
    const started = Date.now();
    expect(nativeAppVariant({ platform: 'android', model: `${'_'.repeat(100_000)}x${' '.repeat(100_000)}` })).toBe('android-x');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('leaves out what the capabilities do not say', () => {
    expect(nativeAppVariant({ platform: 'android' })).toBe('android');
    expect(nativeAppVariant({ platform: 'ios', osVersion: '18.0' })).toBe('ios-18');
  });
});

describe('statusBarFromCapabilities', () => {
  it('is the top of the viewport rectangle, else statBarHeight, else null', () => {
    expect(statusBarFromCapabilities(ANDROID_CAPS)).toBe(136);
    expect(statusBarFromCapabilities({ statBarHeight: 89 })).toBe(89);
    expect(statusBarFromCapabilities(IOS_CAPS)).toBeNull();
    expect(statusBarFromCapabilities({ viewportRect: { top: -4 } })).toBeNull();
  });
});

describe('appiumEnvironment', () => {
  it('records a native-app capture: the host, the device, the scale and the Appium screen capture method', () => {
    const env = appiumEnvironment({ capabilities: ANDROID_CAPS, adapter: ADAPTER, framework: FRAMEWORK, host: HOST });
    expect(env).toEqual({
      os: HOST.os,
      browser: { name: 'native-app', version: null },
      framework: FRAMEWORK,
      adapter: { ...ADAPTER, captureMethod: 'screen:appium' },
      render: { deviceScaleFactor: 2.625 },
      device: {
        platform: 'android',
        osVersion: '14',
        model: 'sdk_gphone64_x86_64',
        automation: 'UiAutomator2',
        screen: '1080x2400',
        density: 420,
      },
    });
  });

  it('records no render block when the session gives no pixel ratio', () => {
    const env = appiumEnvironment({ capabilities: IOS_CAPS, adapter: ADAPTER, framework: FRAMEWORK, host: HOST });
    expect(env.render).toBeUndefined();
    expect(env.device).toEqual({ platform: 'ios', osVersion: '17.5', name: 'iPhone 15', automation: 'XCUITest' });
  });
});

describe('a change of device in the report', () => {
  const base = appiumEnvironment({ capabilities: ANDROID_CAPS, adapter: ADAPTER, framework: FRAMEWORK, host: HOST });
  const with_ = (patch: Partial<CaptureEnvironment>): CaptureEnvironment => ({ ...base, ...patch });

  it('the device OS version, model, screen and density can change rendering; the device name and automation cannot', () => {
    const a = with_({ device: { ...base.device!, name: 'Pixel 6' } });
    const b = with_({ device: { ...base.device!, osVersion: '15', model: 'Pixel 7', screen: '1080x2340', density: 440, name: 'Pixel 7', automation: 'Espresso' } });
    const { delta, renderingDelta } = diffEnvironments(a, b);
    expect(delta).toEqual(['device.automation', 'device.density', 'device.model', 'device.name', 'device.osVersion', 'device.screen']);
    expect(renderingDelta).toEqual(['device.density', 'device.model', 'device.osVersion', 'device.screen']);
  });

  it('for native captures, the machine running the tests is context: the device renders', () => {
    const b = with_({ os: { platform: 'darwin', release: '24.1.0', arch: 'arm64' } });
    const { delta, renderingDelta } = diffEnvironments(base, b);
    // os.distro is recorded on one side only: unknown, not a change.
    expect(delta).toEqual(['os.arch', 'os.platform', 'os.release']);
    expect(renderingDelta).toEqual([]);
  });

  it('a web capture against a native baseline is still a rendering change', () => {
    const web: CaptureEnvironment = { ...base, browser: { name: 'chromium', version: '141.0.7390.37' }, device: undefined };
    delete web.device;
    expect(diffEnvironments(base, web).renderingDelta).toContain('browser.name');
  });

  it('words the device fields', () => {
    const b = with_({ device: { ...base.device!, osVersion: '15', model: 'Pixel 7' } });
    expect(describeEnvironmentChange(base, b, ['device.model', 'device.osVersion'])).toBe(
      'device sdk_gphone64_x86_64 → Pixel 7, device OS 14 → 15',
    );
  });

  it('names the Appium screen capture', () => {
    expect(describeCaptureMethod('screen:appium')).toBe('full screen (Appium)');
  });
});
