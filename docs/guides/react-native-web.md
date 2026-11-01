---
title: React Native via react-native-web
---

# React Native via react-native-web

If your React Native app builds for the web (Expo's web target does), TestivAI
can test its screens today. react-native-web renders your components as
HTML, the Playwright adapter captures them under phone profiles, and every
layer works: pixel diff, DOM diff, style check, element attribution and
shift detection. You add one Playwright project per phone and call
`witness(page, testInfo, 'name')` as you would on any web page. No device,
emulator or Mac is needed, so it runs on the same Linux CI as your web
tests.

:::note Scope: your React Native code, rendered on the web
This tests how your components render **in a browser**, through
react-native-web. It is not the native iOS or Android app: native text and
shadow rendering, `Platform.OS` branches and native-only modules are not
seen. Read [Limits](#limits) before you rely on it, and keep device tests
for what only the native app shows.
:::

The setup below runs end to end in this repository's CI on Pixel 7
(Chromium) and iPhone 13 (WebKit) profiles, with Expo SDK 58,
react-native-web 0.21.4, React 19.3.0 and @playwright/test 1.64.1. The
readings table says which phone each row was measured on. See
[How this was verified](#how-this-was-verified).

---

## Before you start

- **The app has to build for the web.** Expo apps usually do
  (`npx expo export --platform web`). Bare React Native apps often do not
  without extra work, and native-only modules may not render at all.
- **Give the elements you care about a `testID`.** react-native-web renders
  it as `data-testid`, and TestivAI can name changes by it (below). Make
  repeated items unique, e.g. ``testID={`order-${order.id}`}``.
- **`elementIdAttributes` is not in a published release yet.** It is merged
  in this repository and ships with the next minor release of
  `@testivai/witness` and the adapters. With
  `@testivai/witness-playwright` 2.0.10 or older, everything here works
  except testID-based paths: the setting is ignored, with a config warning.

---

## Set it up

A complete, runnable project is in
[`examples/expo-web`](https://github.com/testivai/testivai-oss/tree/main/examples/expo-web). The pieces:

**1. Install the adapter and both engines.** The iPhone profiles run on
WebKit:

```bash
npm install -D @testivai/witness-playwright @playwright/test
npx playwright install chromium webkit --with-deps
```

**2. `.testivai/config.json`:**

```json
{
  "autoOpen": false,
  "elementIdAttributes": ["data-testid"],
  "volatileAttributes": ["class", "src"]
}
```

Each line is there for a reason:

| Setting | Why |
|---|---|
| `elementIdAttributes: ["data-testid"]` | Names changed elements by `testID` (`div[data-testid="track-order"]` instead of `body > div > div.css-g5y9jx > … :nth-of-type(4)`), and keeps their names stable when content is inserted above them, so a moved element reads as a **shift**. |
| `"class"` in `volatileAttributes` | A `StyleSheet` change makes react-native-web swap an atomic class (`r-1jtin5c` → `r-vq2l11`). Without this, the DOM diff counts it as an attribute change and the snapshot does not read as style-only. The style check names the element either way. |
| `"src"` in `volatileAttributes` | Expo names its JavaScript bundle by content hash (`/_expo/static/js/web/index-<hash>.js`), so any code change changes a `<script src>` and counts as a DOM change. The trade-off: an `<img>` whose `src` changes is no longer a DOM change either (its pixels still are). react-native-web's `Image` draws with a `background-image` style, which the style check covers. Leave `"src"` out if your app is not built by Expo. |

**3. `playwright.config.ts`:** serve the web build, and one project per
phone:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [['list'], ['@testivai/witness-playwright/reporter']],
  use: {
    baseURL: 'http://localhost:8081',
    // TestivAI freezes CSS animations, not JS-driven ones.
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'npx expo serve --port 8081',
    url: 'http://localhost:8081',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'pixel-7', use: { ...devices['Pixel 7'] } },
    { name: 'iphone-13', use: { ...devices['iPhone 13'] } },
  ],
});
```

**4. A test:** wait for an element by `testID`, then capture:

```ts
import { test } from '@playwright/test';
import { witness } from '@testivai/witness-playwright';

test('orders screen', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByTestId('track-order').waitFor();
  await witness(page, testInfo, 'orders');
});
```

**5. Run it:**

```bash
npx expo export --platform web   # writes dist/
npx playwright test              # first run: one new snapshot per phone
npx testivai approve --all       # then commit .testivai/baselines/
npx playwright test              # later runs compare against them
npx testivai report --fail-on-diff
```

Snapshots are keyed per project, `orders__pixel-7` and `orders__iphone-13`,
so each phone is compared only with its own baseline. Approving, the PR
comment, `/testivai approve` and the MCP server work as on any web project
([Mobile web](./mobile-web.md#approving-and-gating)).

---

## What each change reads as

Measured on an "Orders" screen (`View`, `Text`, `Pressable`, `StyleSheet`,
`testID`), against an approved baseline of the unchanged screen, with the
config above unless the row says otherwise. Every row was measured on Pixel 7;
the button colour row on iPhone 13 as well:

| Change | Status | What results.json says |
|---|---|---|
| Nothing (three runs in a row) | passed | 0 pixels differ |
| Button colour in `StyleSheet` | changed | `dom.changed: false`, `styleCheck: "mismatch"` on `div[data-testid="track-order"]` (both phones); every change region is on the button (Pixel 7) |
| The same, without `"class"` in `volatileAttributes` | changed | 1 attribute change in the DOM diff (the swapped atomic class), and the same style mismatch on the button |
| Title text | changed | 1 text change, 0 attribute changes; the region is on `div[data-testid="header"] > div` |
| A banner inserted at the top | changed | 5 of 5 regions read **shift** by the banner's height, and the page shift is found |
| The same banner, **without** `elementIdAttributes` | changed | The move is never found: some regions read "change", and look-alike cards read as a **shift by a wrong distance** (see [Limits](#limits)) |

A `StyleSheet` change, a text change and a moved block each get their own
reading, as they do on hand-written HTML.

---

## Limits

| Limit | What happens | What to do |
|---|---|---|
| **Not the native app** | Native text, font and shadow rendering, the status bar, safe areas and the keyboard are not captured. | Keep device or emulator tests for what only the native app shows. |
| **Web branches only** | `Platform.OS === 'web'` code and `.web.js` files are what renders; `.ios.js` / `.android.js` files and their branches are not tested. | Keep platform branches small, or test them on a device. |
| **Native-only modules** | Maps, camera and some animation libraries may not render on the web, or not build. | Mock them in the web build, or mask their area (`mask` in `.testivai/config.json`). |
| **Bare React Native apps** | Often do not build for the web without extra setup. | Expo apps usually do. Verified here on one Expo app and one react-native-web fixture, no bare React Native app. |
| **JS-driven animations** | TestivAI's stabilization freezes CSS animations and transitions, not animations driven from JavaScript. | `reducedMotion: 'reduce'` asks the app to skip them; whether a library honours it is up to that library (Reanimated was **not** tested here). Wait for the settled state before `witness()`. |
| **Element paths without `testID`** | Paths are unreadable (`div.css-g5y9jx:nth-of-type(4)`), and content inserted above an element renumbers it. Look-alike siblings then pair with their neighbours: in the banner case above, two regions read as a **shift of −16 px** while the content moved **+64 px**, and a wrong page shift was reported. | Turn on `elementIdAttributes` and give elements unique `testID`s. A value used twice is skipped, and the path continues to the next unique one above it. |
| **Turning `elementIdAttributes` on** | Paths change for every anchored element, so the style check reads "styles not compared" against baselines captured before. | Re-approve the baselines once after turning it on. |
| **Chromium captures at 1×** | On Pixel 7 the PNG is 412 px wide (CSS pixels), not 2.625×; WebKit captures at the device scale factor. After the capture the page stays at device pixel ratio 1 for the rest of that test, and `metadata.json` records the profile's 2.625. | Compare each phone only with its own baseline (keyed per project, as above). If later steps in the same test depend on the pixel ratio, capture last. See [Mobile web](./mobile-web.md#devicescalefactor-is-applied-on-webkit-and-dropped-on-chromium). |
| **WebKit log line** | Every WebKit capture prints `[TestivAI] Browser screenshot failed: … CDP session is only available in Chromium`. | Nothing: the capture falls back to Playwright's own screenshot, as intended. The message is misleading, not a failure. |
| **Other adapters** | `elementIdAttributes` is read by the Playwright, Selenium (JS) and WebdriverIO adapters. The Python, Java and Ruby adapters keep default paths. | Use the Playwright adapter for this. A baseline directory shared with an adapter that does not read it gets "styles not compared", never a wrong style verdict. |

---

## How this was verified

- **`e2e/src/rn-web.test.ts`** (runs on every pull request): the Orders
  screen written as real React Native, bundled with react-native-web
  0.21.4, captured on the Pixel 7 profile in Chrome. It checks every row of
  [What each change reads as](#what-each-change-reads-as) except iPhone 13.
- **The `Expo example (react-native-web)` CI job** (every pull request):
  installs [`examples/expo-web`](https://github.com/testivai/testivai-oss/tree/main/examples/expo-web) with the
  packages built from the same commit, runs it on Pixel 7 and iPhone 13,
  approves, passes an unchanged run, then recolours the button and requires
  the gate to fail with a style-only change on
  `div[data-testid="track-order"]` on both phones.
- **Not verified:** real devices, apps other than these fixtures, bare React
  Native apps, Reanimated or other JS animation libraries, and Windows or
  macOS runners.

---

## Next steps

- **[Mobile web](./mobile-web.md)**: device profiles, keying and the
  Chromium/WebKit capture differences in detail
- **[How it works](../how-it-works.md#element-paths)**: element paths and
  `elementIdAttributes`
- **[CI/CD](./ci-cd.md)**: the gate, exit codes and sharding
- **[Stable baselines](./stable-baselines.md)**: reducing false positives
