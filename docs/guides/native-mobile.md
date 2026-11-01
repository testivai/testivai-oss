---
title: Native mobile apps (experimental)
---

# Native mobile apps (experimental)

`@testivai/witness-webdriverio` captures native Android and iOS app screens
in a WebdriverIO + Appium session. You call `witness(browser, 'login')` as on
a web page. The adapter sees a native screen, takes the whole screen, masks
the status bar, records the device, and keys the snapshot by device. The
compare, the report, `testivai approve`, the GitHub Action and the MCP server
work as for web snapshots.

:::caution Experimental, and pixel-only
A native screen has no DOM, so only the **pixel diff** applies: no DOM diff,
style check, element attribution or shift detection. It is verified on an
Android 14 emulator in this repository's CI ([How this was
verified](#how-this-was-verified)). **iOS is not verified**: the code path is
the same, but no XCUITest run has been made. The options and snapshot names
may change before this leaves experimental.
:::

---

## Set it up

You need a WebdriverIO project that already drives your app through Appium
(Appium 3 with UiAutomator2 for Android, or XCUITest for iOS), and the
[WebdriverIO setup](../frameworks/webdriverio.md) for TestivAI: the package,
`.testivai/config.json` and the service in `wdio.conf.ts`. Native mode is in
`@testivai/witness-webdriverio` 0.5.0 and later (with `@testivai/witness`
2.6.0); older versions capture a native screen slowly, with no mask or device.

```ts
// wdio.conf.ts (the parts that matter here)
import { TestivaiService } from '@testivai/witness-webdriverio/service';

export const config = {
  port: 4723,
  capabilities: [{
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:app': './apps/demo.apk',
  }],
  services: [[TestivaiService, {}]],
};
```

```ts
import { witness } from '@testivai/witness-webdriverio';

it('login screen', async () => {
  await $('~login-button').waitForDisplayed();
  await witness(browser, 'login');
});
```

The first run writes `login__android-pixel_7-15` (on a Pixel 7 with
Android 15) as a new snapshot. Approve it with `npx testivai approve --all`
and commit `.testivai/baselines/`; later runs compare against it.

---

## What native mode does

Native mode starts by itself when the session runs on Android or iOS, names
no browser, and is in Appium's `NATIVE_APP` context. A hybrid app switched to
a web view (`WEBVIEW_…`) is captured as a web page, with every layer. When
the context cannot be read, a session started with `app`, `appPackage` or
`bundleId` counts as native.

| Part | Native mode | Why |
|---|---|---|
| Page scripts | none run | A native screen has no page: Appium rejects them, and WebdriverIO resends each failed command 3 times. On an Android 14 emulator that cost ~1.5 s per script, ~8 s per capture; in native mode a capture there takes 0.5–1 s. |
| Screenshot | the whole screen, in physical pixels (1080×2400 on a Pixel 7 profile) | Appium's `takeScreenshot()` |
| Status bar | masked, from `mobile: viewportRect` at capture time (136 px on that profile) | the clock, battery and signal change between runs |
| Environment | the device from the capabilities: platform, OS version, model, the Appium driver, screen size, density, pixel ratio | so a device or OS change is listed when pixels differ |
| Snapshot name | `<name>__<platform>-<device>-<osMajor>` | each device is compared only with its own baseline |

The mask is a per-capture mask (`masks: [{ "top": 136 }]` in the capture's
`metadata.json`), shown in the report like any other. The bottom navigation
bar is not masked.

### Options

| Option | Default | What it does |
|---|---|---|
| `native` | detected | `true` forces native mode, `false` keeps the web path |
| `maskStatusBar` | `true` | `false` leaves the status bar in the comparison |
| `variant` | the device key | replaces `<platform>-<device>-<osMajor>` in the name |

```ts
await witness(browser, 'login', { variant: 'pixel-7-api-34' });
```

### Snapshot names

The device part is the model the device reports (Android `deviceModel`),
else the `deviceName` the session asked for (iOS), lowercased:

| Device | Name |
|---|---|
| Pixel 7, Android 15 | `login__android-pixel_7-15` |
| Android 14 emulator | `login__android-sdk_gphone64_x86_64-14` |
| iPhone 15 simulator, iOS 17.5 | `login__ios-iphone_15-17` |

Android emulators all report the same model (`sdk_gphone64_x86_64`). If you
run several emulator profiles with the same Android version, give each its
own `variant`, or they share one baseline (a different screen size then reads
as a size change, never as a pass).

---

## Freeze the status bar at the source

The mask covers the status bar. To keep it out of the screenshot too (for
the report and the pull request comment), freeze it before the tests:

**Android** (emulator or device, over `adb`):

```bash
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command enter
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 1200
adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false
```

**iOS simulator**:

```bash
xcrun simctl status_bar booted override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4
```

---

## What the report says

A native snapshot has no `dom.html`, so `dom` is `null` in `results.json`.
The HTML report and the PR comment show the pixel diff and its change
regions, with no DOM or style reading. The MCP server's verdict says "no DOM
data; treat as needing human review". A changed native snapshot is never
called render noise or rendering drift.

When the device changed since the baseline (another model, OS version, screen
or density), the report lists it, for example
`device sdk_gphone64_x86_64 → Pixel 7, device OS 14 → 15`. The machine
running the tests is not a rendering change for native captures: the device
draws the screen.

---

## Limits

| Limit | What happens | What to do |
|---|---|---|
| **Pixel-only** | No DOM diff, style check, element attribution or shift detection. A moved block reads as a change. | Review native diffs by eye. |
| **Live values on screen** | Clocks, counters and storage figures inside the app change between runs. In Android's Settings, the storage line changed within minutes. | Mask them (`mask` in `.testivai/config.json`), or seed the app with fixed data. |
| **Animations, keyboard, scroll** | Native animations are not frozen; an open keyboard or a scrolled list is in the screenshot. | Disable animations on the device (`adb shell settings put global animator_duration_scale 0`, and the window and transition scales), hide the keyboard, scroll to a fixed place before `witness()`. |
| **Toolchain updates** | A new system image, Xcode or emulator GPU can change every image. The environment lists the device fields that changed. | Re-baseline after a toolchain update. Pin Appium and driver versions in CI. |
| **iOS** | Not verified. XCUITest offers `mobile: viewportRect`, so the code path is the Android one. | Report what you see in a GitHub issue. |
| **Other languages** | Only the WebdriverIO adapter has native mode. The Java, Python and Ruby adapters capture web pages. | Use WebdriverIO for native screens. |
| **Navigation bar, notches, rotation** | Only the top status bar is masked. The bar's height is measured at each capture, so rotation is followed. | Mask the bottom bar with a config mask if it changes. |

---

## How this was verified

- **Unit tests** (`packages/webdriverio/src/__tests__/native.test.ts`): fake
  Android and iOS Appium sessions. They check detection (and that browser
  sessions make no extra call), that no page script runs, the mask from
  `mobile: viewportRect` and its fallbacks, the environment block, the
  snapshot name, and that a status-bar-only change passes the compare while a
  change below it does not.
- **The `Android native` CI job** (`.github/workflows/android-native.yml`,
  on pull requests that touch the adapter or `@testivai/witness`): Android 14
  (API 34) emulator, Pixel 7 profile, Appium 3.9.0 with UiAutomator2 8.7.3,
  Android's Settings app, the clock frozen with demo mode. It checks that no
  page script runs, the environment and mask in `metadata.json`, the
  snapshot name, that the same screen passes, that a clock change passes with
  the automatic mask alone, and that dark mode is a change that fails
  `testivai report --fail-on-diff`.
- **Not verified:** iOS, real devices, device farms, apps other than
  Settings, Android versions other than 14.

---

## Next steps

- **[WebdriverIO](../frameworks/webdriverio.md)**: the adapter's setup and
  service options
- **[Mobile web](./mobile-web.md)**: phone profiles for web pages, with every
  layer
- **[Stable baselines](./stable-baselines.md)**: masks and other ways to cut
  false positives
