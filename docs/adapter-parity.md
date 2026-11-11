---
title: Adapter parity
---

# Adapter parity

Every adapter writes the same on-disk contract ([Extension API](./extension-api.md)), but
not every adapter writes all of it. This page says, adapter by adapter, which capture
features it has, with the file that shows it. It was written from the code, not from the
other docs; a test (`action/src/__tests__/adapter-parity-docs.test.ts`) fails when an
adapter listed here leaves the repo, when a new adapter folder is not listed, or when a
file cited here no longer exists.

What the columns mean:

| Column | Yes means |
|---|---|
| DOM snapshot | The adapter writes `dom.html` (the page's HTML, ignored elements removed): the DOM diff and the noise hint. |
| Element map | It writes `elements.json` with the shared collector (`collectElementMap`, shipped to Python, Ruby and Java as a generated script): selector attribution, page-shift detection. |
| Style digest | Its element map carries each element's `styleHash`, so the compare can say whether computed styles changed (`dom.styleCheck`). Without it, an identical DOM reads "styles not compared", never likely render noise. |
| Capture until stable | It takes screenshots until two in a row match ([`stable-capture.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/capture/stable-capture.ts)), which guards against Chrome returning a frame painted for the wrong viewport. Waiting for the page to settle before one screenshot is not this. |
| Masks | It measures selector masks at capture time (`maskRects` in the capture's `metadata.json`) and takes masks per call. **Partial:** it does neither, so only region masks (`x`, `y`, `width`, `height`) from `config.json` work, which the compare applies to every adapter's captures; a selector mask there only warns. |
| Capture health | It records what failed to load (`health` in `metadata.json`, from `HEALTH_PROBE_EXPRESSION`), so a failed web font or stylesheet reads as an unhealthy capture, never as render noise. |
| Capture provenance | It records where the capture came from (`environment` in `metadata.json`), so a diff caused by a new browser, OS or capture method reads as rendering drift. |
| Per-browser baselines | It applies `environmentPolicy: "separate"` and keys snapshots `<name>__<browser>__<platform>` by itself. **Partial:** only a manual variant suffix. |

## Summary

| Adapter | Code | DOM snapshot | Element map | Style digest | Capture until stable | Masks | Capture health | Capture provenance | Per-browser baselines |
|---|---|---|---|---|---|---|---|---|---|
| Playwright (JS/TS) | [`packages/playwright`](https://github.com/testivai/testivai-oss/blob/main/packages/playwright/src/snapshot.ts) | yes | yes | yes | partial | yes | yes | yes | yes |
| WebdriverIO (JS/TS) | [`packages/webdriverio`](https://github.com/testivai/testivai-oss/blob/main/packages/webdriverio/src/witness.ts) | yes | yes | yes | no | partial | no | yes | yes |
| Selenium (JS/TS) | [`packages/selenium`](https://github.com/testivai/testivai-oss/blob/main/packages/selenium/src/witness.ts) | yes | yes | yes | partial | partial | no | yes | yes |
| Python Playwright | [`python`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_capture.py) | yes | no | no | no | partial | yes | yes | partial |
| Python Selenium | [`python`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/selenium.py) | yes | yes | yes | no | partial | yes | yes | partial |
| Ruby (Capybara / Selenium) | [`ruby`](https://github.com/testivai/testivai-oss/blob/main/ruby/lib/testivai/capture.rb) | yes | yes | yes | no | partial | no | no | no |
| Java Playwright | [`java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/Witness.java) | yes | no | no | no | partial | no | no | partial |
| Java Selenium | [`java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/SeleniumWitness.java) | yes | yes | yes | no | partial | no | no | partial |
| Standalone CLI | [`packages/witness`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/standalone/run.ts) | yes | no | no | yes | partial | yes | yes | yes |

The standalone CLI is `testivai witness <url>`, which captures pages without a test framework.

## Evidence

### Playwright (JS/TS)

| Feature | Status | Where | Note |
|---|---|---|---|
| DOM snapshot | yes | [`snapshot.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/playwright/src/snapshot.ts) `snapshot()` | Taken after the capture styles come off. |
| Element map | yes | [`snapshot.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/playwright/src/snapshot.ts) `buildElementMapExpression` | Shared collector, with `elementIdAttributes`. |
| Style digest | yes | [`element-map.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/capture/element-map.ts) `collectElementMap` | `styleHash` per element. |
| Capture until stable | partial | [`full-page.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/playwright/src/capture/full-page.ts) `captureFullPageScreenshot` | Only the CDP path on Chromium. Firefox and WebKit, a failed CDP capture, and `useBrowserCapture: false` take one screenshot. |
| Masks | yes | [`snapshot.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/playwright/src/snapshot.ts) `maskRects` | Config and per-call selector masks measured in the page; per-call region masks. |
| Capture health | yes | [`health.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/playwright/src/capture/health.ts) `probeCaptureHealth` | In-page probe right after the screenshot, before the capture styles come off. No network-side evidence. |
| Capture provenance | yes | [`environment.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/playwright/src/capture/environment.ts) `playwrightEnvironment` | `full-page:cdp`, `full-page:playwright` or `full-page:stitched`; framework and project included. |
| Per-browser baselines | yes | [`snapshot.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/playwright/src/snapshot.ts) `applyEnvironmentPolicyToName` | With more than one project, the project name is a suffix whatever the policy. |

### WebdriverIO (JS/TS)

| Feature | Status | Where | Note |
|---|---|---|---|
| DOM snapshot | yes | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/webdriverio/src/witness.ts) `witness()` | Web pages only; a native app screen has no DOM. |
| Element map | yes | [`element-map.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/webdriverio/src/element-map.ts) `toViewportElementMap` | Shared collector, moved to viewport coordinates to match the viewport screenshot. |
| Style digest | yes | [`element-map.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/capture/element-map.ts) `collectElementMap` | |
| Capture until stable | no | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/webdriverio/src/witness.ts) `takeScreenshot` | One viewport screenshot (WebDriver `takeScreenshot`), after a web-font wait. No full-page capture. |
| Masks | partial | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/webdriverio/src/witness.ts) `writeTempMetadata` | No selector or per-call masks. Native app captures get an automatic status-bar mask. |
| Capture health | no | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/webdriverio/src/witness.ts) `witness()` | No probe; no `health` written. |
| Capture provenance | yes | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/webdriverio/src/witness.ts) `webDriverEnvironment` | `viewport:webdriver`; native app captures `screen:appium` with a `device` section. |
| Per-browser baselines | yes | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/webdriverio/src/witness.ts) `applyEnvironmentPolicyToName` | The platform is the machine running the tests, not a remote browser's. |

### Selenium (JS/TS)

| Feature | Status | Where | Note |
|---|---|---|---|
| DOM snapshot | yes | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/selenium/src/witness.ts) `witness()` | |
| Element map | yes | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/selenium/src/witness.ts) `buildElementMapExpression` | Shared collector, in page coordinates, also on the viewport fallback. |
| Style digest | yes | [`element-map.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/capture/element-map.ts) `collectElementMap` | |
| Capture until stable | partial | [`full-page.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/selenium/src/capture/full-page.ts) `captureFullPageScreenshot` | Only the CDP path (Chrome, Edge). Other browsers, and a failed CDP capture, take one viewport screenshot. A settle wait runs before either. |
| Masks | partial | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/selenium/src/witness.ts) `writeTempMetadata` | No selector or per-call masks. |
| Capture health | no | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/selenium/src/witness.ts) `witness()` | No probe; no `health` written. |
| Capture provenance | yes | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/selenium/src/witness.ts) `webDriverEnvironment` | `full-page:cdp` or `viewport:webdriver`. |
| Per-browser baselines | yes | [`witness.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/selenium/src/witness.ts) `applyEnvironmentPolicyToName` | |

### Python Playwright

| Feature | Status | Where | Note |
|---|---|---|---|
| DOM snapshot | yes | [`_capture.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_capture.py) `witness()` | |
| Element map | no | [`_capture.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_capture.py) `witness()` | The collector is loaded in this module, but only the Selenium adapter calls it. |
| Style digest | no | [`_capture.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_capture.py) `witness()` | No element map. |
| Capture until stable | no | [`_capture.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_capture.py) `witness()` | One `page.screenshot(full_page=True)` after a web-font wait; no settle wait. |
| Masks | partial | [`_capture.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_capture.py) `witness()` | No masks; `ignore_selectors` hides elements, it does not mask them. |
| Capture health | yes | [`_capture.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_capture.py) `_shoot()`, [`_health.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_health.py) `probe_health` | The generated [`health_probe.js`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/health_probe.js) right after the screenshot, before the capture styles come off (since 0.3.0). No network-side evidence. |
| Capture provenance | yes | [`_environment.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_environment.py) `playwright_environment` | `full-page:playwright`; the browser from Playwright, else the user agent; `variant` as the project (since 0.3.0). |
| Per-browser baselines | partial | [`_capture.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_capture.py) `sanitize_variant` | `variant=` gives `<name>__<variant>`; `environmentPolicy` is not read. |

### Python Selenium

| Feature | Status | Where | Note |
|---|---|---|---|
| DOM snapshot | yes | [`selenium.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/selenium.py) `witness()` | |
| Element map | yes | [`selenium.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/selenium.py) `_element_map_expression` | Generated `element_map.js`; `elementIdAttributes` is not passed. |
| Style digest | yes | [`element_map.js`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/element_map.js) `collectElementMap` | |
| Capture until stable | no | [`selenium.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/selenium.py) `_capture_screenshot` | One screenshot (CDP full page on Chrome and Edge, Firefox full page, else the viewport) after a web-font and settle wait. |
| Masks | partial | [`selenium.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/selenium.py) `witness()` | No masks. |
| Capture health | yes | [`selenium.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/selenium.py) `_shoot()`, [`_health.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_health.py) `probe_health` | Same probe and timing as the Playwright path (since 0.3.0). No network-side evidence. |
| Capture provenance | yes | [`selenium.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/selenium.py) `_environment()`, [`_environment.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/_environment.py) `webdriver_environment` | `full-page:cdp`, `full-page:firefox` or `viewport:webdriver`, whichever took the screenshot; browser and driver from the capabilities (since 0.3.0). |
| Per-browser baselines | partial | [`selenium.py`](https://github.com/testivai/testivai-oss/blob/main/python/src/testivai/selenium.py) `witness()` | `variant=` only. |

### Ruby (Capybara / Selenium)

| Feature | Status | Where | Note |
|---|---|---|---|
| DOM snapshot | yes | [`capture.rb`](https://github.com/testivai/testivai-oss/blob/main/ruby/lib/testivai/capture.rb) `witness` | Works with Capybara's Selenium driver or a Selenium driver. |
| Element map | yes | [`element_map.rb`](https://github.com/testivai/testivai-oss/blob/main/ruby/lib/testivai/element_map.rb) | Generated `element_map.js`; `elementIdAttributes` is not passed. |
| Style digest | yes | [`element_map.js`](https://github.com/testivai/testivai-oss/blob/main/ruby/lib/testivai/element_map.js) `collectElementMap` | |
| Capture until stable | no | [`capture.rb`](https://github.com/testivai/testivai-oss/blob/main/ruby/lib/testivai/capture.rb) `capture_screenshot` | One screenshot after a web-font wait and [`settle.rb`](https://github.com/testivai/testivai-oss/blob/main/ruby/lib/testivai/settle.rb). |
| Masks | partial | [`capture.rb`](https://github.com/testivai/testivai-oss/blob/main/ruby/lib/testivai/capture.rb) `witness` | No masks. |
| Capture health | no | [`capture.rb`](https://github.com/testivai/testivai-oss/blob/main/ruby/lib/testivai/capture.rb) `witness` | No `metadata.json` is written. |
| Capture provenance | no | [`capture.rb`](https://github.com/testivai/testivai-oss/blob/main/ruby/lib/testivai/capture.rb) `witness` | No `metadata.json` is written. |
| Per-browser baselines | no | [`capture.rb`](https://github.com/testivai/testivai-oss/blob/main/ruby/lib/testivai/capture.rb) `witness` | No variant option, no `environmentPolicy`. |

### Java Playwright

| Feature | Status | Where | Note |
|---|---|---|---|
| DOM snapshot | yes | [`Witness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/Witness.java) `witness` | |
| Element map | no | [`Witness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/Witness.java) `witness` | `CaptureOptions` has `skipElementMap`, but this adapter never runs the collector. |
| Style digest | no | [`Witness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/Witness.java) `witness` | No element map. |
| Capture until stable | no | [`Witness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/Witness.java) `witness` | One full-page Playwright screenshot after a web-font wait. |
| Masks | partial | [`CaptureOptions.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/CaptureOptions.java) | No mask option. |
| Capture health | no | [`Witness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/Witness.java) `witness` | No `metadata.json` is written. |
| Capture provenance | no | [`Witness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/Witness.java) `witness` | No `metadata.json` is written. |
| Per-browser baselines | partial | [`Witness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/Witness.java) `witness` | `variant` only; `environmentPolicy` is not read. |

### Java Selenium

| Feature | Status | Where | Note |
|---|---|---|---|
| DOM snapshot | yes | [`SeleniumWitness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/SeleniumWitness.java) `witness` | |
| Element map | yes | [`ElementMap.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/ElementMap.java) | Generated `element-map.js`; `elementIdAttributes` is not passed. |
| Style digest | yes | [`element-map.js`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/resources/ai/testiv/testivai/element-map.js) `collectElementMap` | |
| Capture until stable | no | [`SeleniumWitness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/SeleniumWitness.java) `captureScreenshot` | One screenshot (CDP, Firefox full page, else the viewport) after a web-font wait and [`Settle.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/Settle.java). |
| Masks | partial | [`CaptureOptions.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/CaptureOptions.java) | No mask option. |
| Capture health | no | [`SeleniumWitness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/SeleniumWitness.java) `witness` | No `metadata.json` is written. |
| Capture provenance | no | [`SeleniumWitness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/SeleniumWitness.java) `witness` | No `metadata.json` is written. |
| Per-browser baselines | partial | [`SeleniumWitness.java`](https://github.com/testivai/testivai-oss/blob/main/java/src/main/java/ai/testiv/testivai/SeleniumWitness.java) `witness` | `variant` only. |

### Standalone CLI

| Feature | Status | Where | Note |
|---|---|---|---|
| DOM snapshot | yes | [`run.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/standalone/run.ts) `runStandaloneWitness` | |
| Element map | no | [`run.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/standalone/run.ts) `runStandaloneWitness` | By design, as the file's header says: styles are not compared for these captures. |
| Style digest | no | [`run.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/standalone/run.ts) `runStandaloneWitness` | No element map. |
| Capture until stable | yes | [`run.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/standalone/run.ts) `captureFullPage` | CDP in Chrome, its only capture path. |
| Masks | partial | [`run.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/standalone/run.ts) `runStandaloneWitness` | No masks measured. |
| Capture health | yes | [`run.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/standalone/run.ts) `standaloneHealth` | The in-page probe plus failed requests seen on the network (`watchNetwork`), cross-origin ones included. |
| Capture provenance | yes | [`run.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/standalone/run.ts) `standaloneEnvironment` | `full-page:cdp`; no framework. |
| Per-browser baselines | yes | [`run.ts`](https://github.com/testivai/testivai-oss/blob/main/packages/witness/src/standalone/run.ts) `applyEnvironmentPolicyToName` | Always `chromium`. |
