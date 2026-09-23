# @testivai/witness-selenium

## 0.3.3

### Patch Changes

- Updated dependencies [fcd39f8]
  - @testivai/witness@2.0.2

## 0.3.2

### Patch Changes

- Updated dependencies [e289450]
  - @testivai/witness@2.0.1

## 0.3.1

### Patch Changes

- Updated dependencies [5af0816]
- Updated dependencies [ec92541]
  - @testivai/witness@2.0.0

## 0.3.0

### Minor Changes

- f80f6c6: Sharded and parallel runs now work the same way in every language, not just Playwright. `TESTIVAI_SHARD=i/N` and `TESTIVAI_CAPTURE_ONLY=1` are honoured by the Playwright, Selenium, Python, Java and Ruby adapters, so a Selenium or pytest suite joins the same capture → merge → compare-once flow with the same completeness guarantee. Playwright still auto-detects `--shard`, now as a convenience on top of the shared contract rather than a separate mechanism.

  Also fixes a real bug in the pytest plugin: `pytest_sessionfinish` fires in every xdist worker, so `pytest -n 8` launched eight concurrent comparisons racing on the same `visual-report/`. Only the controller reports now.

- 09eafd4: Captures now wait for the page to stop changing, in every language. On top of the existing animation/caret/font stabilization, `stabilize` waits for `document.readyState === 'complete'`, for every image to finish, and for 150ms without DOM mutations — bounded at 5 seconds, so a page that never settles is captured rather than hanging the suite. The probe is generated from one TypeScript source and shipped to the Python, Java and Ruby adapters, so all five poll the identical predicate. Deliberately not network idle, which Playwright's own docs mark DISCOURAGED for testing and which is the wrong signal for a screenshot.

### Patch Changes

- Updated dependencies [f80f6c6]
- Updated dependencies [09eafd4]
- Updated dependencies [6fdc1db]
  - @testivai/witness@1.13.0

## 0.2.0

### Minor Changes

- 0eb2adb: The Selenium (JavaScript) adapter now captures the element map, so region→selector attribution, the style-only-change verdict, and page-shift detection work there exactly as they do for Playwright. The page-side collector moved into `@testivai/witness` and is exported as `collectElementMap` / `buildElementMapExpression`, so every adapter injects the identical function rather than a copy. New per-call options: `skipElementMap` and `maxElements`. Capture is best-effort — if the script is blocked, the report falls back to the pixel and DOM layers instead of failing.

### Patch Changes

- Updated dependencies [ffc2171]
- Updated dependencies [90109b5]
- Updated dependencies [2a37518]
- Updated dependencies [750562e]
- Updated dependencies [1efe97f]
- Updated dependencies [c9b01a6]
- Updated dependencies [003765d]
- Updated dependencies [cba53b5]
- Updated dependencies [0eb2adb]
- Updated dependencies [9aa0f14]
- Updated dependencies [8997ccd]
  - @testivai/witness@1.12.0

## 0.1.10

### Patch Changes

- Updated dependencies [b70ebd9]
  - @testivai/witness@1.11.1

## 0.1.9

### Patch Changes

- Updated dependencies [f94048d]
- Updated dependencies [8de6c13]
  - @testivai/witness@1.11.0

## 0.1.8

### Patch Changes

- Updated dependencies [271f30d]
  - @testivai/witness@1.10.0

## 0.1.7

### Patch Changes

- Updated dependencies [381279b]
  - @testivai/witness@1.9.0

## 0.1.6

### Patch Changes

- Updated dependencies [139d28d]
- Updated dependencies [1c4c883]
  - @testivai/witness@1.8.0

## 0.1.5

### Patch Changes

- Updated dependencies [fa0deb5]
- Updated dependencies [e37eb33]
  - @testivai/witness@1.7.1

## 0.1.4

### Patch Changes

- Updated dependencies [5bfdca5]
- Updated dependencies [9db57c2]
  - @testivai/witness@1.7.0

## 0.1.3

### Patch Changes

- Updated dependencies [2168b81]
  - @testivai/witness@1.6.0

## 0.1.2

### Patch Changes

- Updated dependencies [a13563e]
  - @testivai/witness@1.5.0

## 0.1.1

### Patch Changes

- Updated dependencies [a8cbabf]
  - @testivai/witness@1.4.0

## 0.1.0

### Minor Changes

- e2d634d: New package: native Selenium WebDriver adapter. `testivai.witness(driver, name)` captures through Selenium's public APIs — full-page via CDP on Chrome/Edge, viewport elsewhere — with the same stabilization, ignoreSelectors, variant keying, and on-disk contract as every other TestivAI adapter. Pairs with `testivai report` for the compare/report half.

### Patch Changes

- Updated dependencies [7cb179f]
  - @testivai/witness@1.3.1
