---
title: Java (experimental)
---

# Java adapter — `ai.testiv:testivai` (experimental)

New here? [vs. rolling your own](../vs-selenium-tooling.md) covers what this replaces (including how it compares to AShot).

:::warning Experimental
The Java adapter ships full source in [`java/`](https://github.com/testivai/testivai-oss/tree/main/java) with the same
capture semantics as every other adapter — compiled and unit-tested in CI
(JUnit 5 + Mockito) — but is not yet published to Maven Central. Build it
with `mvn package` for now; feedback and contributions welcome.
:::

Local-first visual regression for **playwright-java and Selenium**
(`SeleniumWitness.witness(driver, ...)` — see the
[Selenium guide](./selenium.md)), sharing baselines,
tolerances, report, and PR approvals with the JS/TS and Python adapters.
Node.js is required for the compare/report step — playwright-java already
ships a Node driver.

## Usage (JUnit 5)

```java
import ai.testiv.testivai.CaptureOptions;
import ai.testiv.testivai.TestivAIExtension;
import ai.testiv.testivai.Witness;

@ExtendWith(TestivAIExtension.class)   // runs `testivai report` after the run
class HomepageTest {

  @Test
  void homepage() {
    page.navigate("http://localhost:3000");
    Witness.witness(page, "homepage");
  }

  @Test
  void pricing() {
    page.navigate("http://localhost:3000/pricing");
    Witness.witness(page, "pricing", new CaptureOptions()
        .setIgnoreSelectors(List.of(".live-chat"))  // hidden from pixels AND the DOM signal
        .setVariant("chromium"));                    // keys baselines per browser
  }
}
```

Without JUnit: call `Runner.runReport()` yourself after your tests.

First run creates `new` snapshots — approve and commit:

```bash
npx testivai approve --all
git add .testivai/baselines/
```

## Capture semantics

Identical to the other adapters: stabilization CSS (animations complete at
final state, caret hidden, fonts awaited), `ignoreSelectors` excluded from
pixels and DOM, `variant` folded into the snapshot name, on-disk contract
`.testivai/temp/<name>/{screenshot.png, dom.html}`. Configuration comes from
the same `.testivai/config.json`.
