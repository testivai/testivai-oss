---
sidebar_position: 3
title: Headless Chrome
---

# Headless Chrome

TestivAI captures whatever browser your tests drive, headless or not. Headless
is the usual setup for CI and servers: no display, no window manager, and
nothing to install beyond the browser itself.

## Keep capture conditions identical

A baseline only means something against captures taken the same way. Between
the run that approved a baseline and every run that compares against it, keep
these the same:

- **Browser and version.** Pin it (lockfile, Docker image tag). See
  [Docker](./docker.md).
- **Headless or headed.** Don't approve from a headed local run and compare in
  headless CI.
- **Viewport size.** Headless Chrome's default window is small (780×580 in
  Chrome 141) and is not guaranteed to stay the same between versions, so set
  the size explicitly.
- **OS and fonts.** See
  [cross-platform baselines](./stable-baselines.md#cross-platform-baselines).

## Per framework

**Playwright** runs headless by default. The viewport comes from your project
config (`use: { viewport: { width: 1280, height: 800 } }`) or a device profile
for [mobile web](./mobile-web.md).

**Selenium** needs headless and the window size set on the driver:

```js
const options = new chrome.Options().addArguments('--headless=new', '--window-size=1280,800');
```

```python
options = webdriver.ChromeOptions()
options.add_argument("--headless=new")
options.add_argument("--window-size=1280,800")
```

The [Selenium guide](../frameworks/selenium.md) covers which browsers capture
the full page and which capture the viewport.

**WebdriverIO** takes the same Chrome arguments in its capabilities:

```js
capabilities: [{
  browserName: 'chrome',
  'goog:chromeOptions': { args: ['--headless=new', '--window-size=1280,800'] },
}],
```

## No test suite: standalone mode is headless

`npx testivai witness <url>` launches its own headless Chrome
(`--headless=new`, scrollbars hidden) at a 1280×800 viewport. Change the size
with `--viewport 1440x900` or `viewport` in `.testivai/config.json`. See
[`testivai witness`](../cli/capture.md) for the flags, and
[Docker](./docker.md#running-as-root) for the environment variables that pick
the binary and control the sandbox.

To capture from a Chrome you started yourself, start it with a debugging port
and pass the same port:

```bash
google-chrome --headless=new --remote-debugging-port=9222 &
npx testivai witness http://localhost:3000 --port 9222
```
