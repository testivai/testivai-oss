# Selenium

Selenium ships no visual comparison of its own — see [what TestivAI adds over a hand-rolled screenshot diff](../vs-selenium-tooling.md).

All three adapters — JavaScript, Python, and Java — capture the **element map**
(selectors, bounding boxes, computed-style digests) using the same injected
collector as the Playwright adapter, so region→selector attribution, the
style-only-change verdict, and page-shift detection work identically in every
language.

Native TestivAI adapters for Selenium WebDriver in **JavaScript, Python, and
Java** — no sidecar, no Chrome debug port, no wrapper process. The adapter
calls Selenium's public APIs and shares baselines, tolerances, the HTML
report, and the `/testivai approve` flow with every other TestivAI adapter.

Works inside any test runner (Jest, Mocha, pytest, unittest, JUnit 5,
TestNG) — the adapter only needs the `driver` object.

## Full-page screenshots per browser

| Browser | JS | Python | Java |
|---|---|---|---|
| Chrome / Edge | full page (CDP) | full page (CDP) | full page (CDP) |
| Firefox | viewport | full page (native API) | full page (native API) |
| Safari / others | viewport | viewport | viewport |

Chromium full-page capture uses CDP `Page.captureScreenshot` with
`captureBeyondViewport` — the same mechanism Playwright uses. The window is
never resized (resizing breaks `100vh` layouts). Viewport captures are
consistent run-to-run, so baselines still work — just size the window to
what you want compared.

## JavaScript

```bash
npm i -D @testivai/witness-selenium @testivai/witness selenium-webdriver
```

```js
import { Builder } from 'selenium-webdriver';
import { testivai } from '@testivai/witness-selenium';

const driver = await new Builder().forBrowser('chrome').build();
await driver.get('http://localhost:3000');
await testivai.witness(driver, 'homepage');
await driver.quit();
```

```bash
npx testivai report            # compare + render report (--fail-on-diff in CI)
npx testivai approve --all     # promote captures to baselines
```

## Python (pytest, unittest, anything)

```bash
pip install "testivai[selenium]"
```

```python
from selenium import webdriver
from testivai.selenium import witness

def test_homepage(driver):          # your own driver fixture
    driver.get("http://localhost:3000")
    witness(driver, "homepage")
```

The bundled pytest plugin runs `testivai report` automatically at session
end (`TESTIVAI_AUTO_REPORT=0` to opt out). Outside pytest, run
`testivai report` yourself — Node.js is the only requirement.

## Java (JUnit 5, TestNG)

```xml
<dependency>
  <groupId>ai.testiv</groupId>
  <artifactId>testivai</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
<!-- you already have org.seleniumhq.selenium:selenium-java -->
```

:::note Not on Maven Central yet
The Java artifact is not published to Maven Central. Build and install it
locally first — `cd java && mvn install` — or see the
[Java adapter page](./java.md). Say the word if you need it published.
:::

```java
import ai.testiv.testivai.SeleniumWitness;

WebDriver driver = new ChromeDriver();
driver.get("http://localhost:3000");
SeleniumWitness.witness(driver, "homepage");
```

Selenium and Playwright support live in separate classes, so whichever
framework you use, the other's dependency is never loaded.

## Options (identical across languages)

- `ignoreSelectors` — elements hidden from pixels AND excluded from the DOM
  snapshot (dynamic badges, ads, live widgets). Merged with the global list
  in `.testivai/config.json`.
- `variant` — folds into the snapshot name (`homepage__firefox`) so
  multi-browser runs keep separate baselines.
- `stabilize` — animation freeze + caret hide + font wait (default on, the
  top flake killers).
- `skipDom` — pixel diff only, no noise hint.

## C#, Ruby, and everything else

Selenium bindings without a native adapter can use the experimental
[`testivai run` sidecar](../sidecar-testivai-run.md) (drives Chrome over a
debug port), or write the two files of the
[on-disk contract](../extension-api.md) directly:
`.testivai/temp/<name>/screenshot.png` (+ optional `dom.html`), then shell
out to `testivai report`. That contract is the entire adapter API — the
Python adapter is ~200 lines if you want a template.

## Working examples

The [example repo](https://github.com/testivai/testivai-example) is a
complete, minimal consumer project — a static page, three `witness()` calls,
the PR `/testivai approve` flow, and a
[live report](https://testivai.github.io/testivai-example/) published from CI.
