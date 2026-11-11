# Changelog — `testivai` (PyPI)

The Python adapters for playwright-python and Selenium. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/spec/v2.0.0.html). Releases before 0.3.0 have no
entries here: see the `python-v0.2.0` tag.

## [0.3.0] - Unreleased

### Added

- Capture health: both adapters record `health` in `.testivai/temp/<name>/metadata.json`, what failed to load (web fonts, stylesheets, images, requests that answered 400 or more), read in the page right after the screenshot and before the capture's styles come off. The probe is the JS adapters' own `HEALTH_PROBE_EXPRESSION`, shipped as the generated `health_probe.js`, and its result is checked as `parseHealth` checks it; a probe that fails or answers something malformed writes no `health` ("not checked", never healthy). A web font or stylesheet that failed now makes the report call the snapshot an unhealthy capture instead of likely render noise, and approving freezes the block into the baseline.
- Capture provenance: both adapters record `environment` in the same file: the OS (spelled as Node spells it, `x64`, `win32`), the Linux distro, the browser and its version, Playwright or Selenium and its version, `pytest` when a test is running, the adapter and how it took the screenshot (`full-page:playwright`; for Selenium `full-page:cdp`, `full-page:firefox` or `viewport:webdriver`, whichever path ran), the driver from the Selenium capabilities, the render settings measured in the page (`render_probe.js`), the CI provider and runner image, a container, `TESTIVAI_ENV_LABEL`, and `variant` as the project. A diff caused by another browser build or machine now reads as rendering drift. Selenium records no `environment` when neither the capabilities nor the user agent name the browser.
- `testivai.__version__` comes from `testivai._version`.

### Changed

- `metadata.json` is written whole for each capture (`name`, then `environment` and `health` when observed); it was not written before. A `health` block from an earlier run cannot survive a run that could not check.
