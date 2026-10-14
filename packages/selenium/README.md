# @testivai/witness-selenium

Selenium WebDriver adapter for [TestivAI Witness](https://github.com/testivai/testivai-oss) — local-first visual regression testing with pixel, DOM and computed-style comparison. No account, nothing uploaded.

Shares baselines, tolerances, the HTML report, and the PR approval flow with every other TestivAI adapter (Playwright, WebdriverIO, Python, Java) through one on-disk contract.

## Install

```bash
npm i -D @testivai/witness-selenium @testivai/witness selenium-webdriver
```

## Use

```js
const { Builder } = require('selenium-webdriver');
const { testivai } = require('@testivai/witness-selenium');

const driver = await new Builder().forBrowser('chrome').build();
await driver.get('http://localhost:3000');
await testivai.witness(driver, 'homepage');
await driver.quit();
```

Then compare against baselines and render the report:

```bash
npx testivai report            # add --fail-on-diff in CI
npx testivai approve --all     # promote current captures to baselines
```

Works inside any runner (Jest, Mocha, plain Node scripts) — the adapter only needs the `driver` object.

## Options

```js
await testivai.witness(driver, 'pricing', {
  ignoreSelectors: ['.live-chat', '[data-testid="ad"]'], // hidden from pixels AND the DOM snapshot
  variant: 'firefox',       // baselines keyed as pricing__firefox
  stabilize: false,         // skip animation-freeze + font wait for this capture
  skipDom: true,            // no DOM diff, noise hint or style check
});
```

Global settings (thresholds, tolerances, `ignoreSelectors`) live in `.testivai/config.json` — see the [main docs](https://github.com/testivai/testivai-oss/tree/main/docs).

## DOM and style check

Each capture writes `dom.html` and `elements.json` (each element's box and computed-style digest) next to the screenshot. When pixels differ and the DOM is identical, the report reads:

- computed styles identical → likely render noise (anti-aliasing, font hinting): likely, not proven;
- computed styles differ → a style-only change, which is real, with the restyled elements named;
- styles not compared (no element map on one side, e.g. `skipElementMap: true` or a blocked collector script) → could be render noise or a stylesheet-only change, so compare the images before approving.

All of these stay `changed` unless you configure a pass criterion; `noiseAutoPass` passes only the first.

## Full-page screenshots

- **Chrome / Edge** — true full-page capture via CDP (`captureBeyondViewport`), the same mechanism Playwright uses. Automatic; nothing to configure.
- **Firefox / Safari** — the Selenium JS bindings expose no full-page API, so captures are viewport-sized. Set the window to the size you want compared; runs are consistent either way. (The Python and Java TestivAI adapters do full-page on Firefox via its native API.)

## Stabilized captures

Before every capture (default on): CSS animations/transitions complete instantly at their final state, the caret is hidden, smooth scrolling is disabled, and web fonts are awaited (bounded 10s). These are the top causes of flaky visual diffs.

## License

MIT
