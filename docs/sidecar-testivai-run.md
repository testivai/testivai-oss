---
sidebar_position: 7
title: testivai run (experimental)
---

# `testivai run` — experimental sidecar mode

:::warning Experimental
The `testivai run` sidecar is experimental in this iteration. Use it as a fallback for frameworks that don't yet have a first-class adapter (e.g. Robot Framework, Cucumber-Java). For Playwright and WebdriverIO, prefer the dedicated adapters — they are more reliable.
:::

## What it is

`testivai run "<your test command>"` is a wrapper that:

1. Spawns your test command (`cypress run`, `wdio`, `pytest`, etc.) as a child process
2. Polls Chrome's remote debugging port (`--remote-debugging-port=9222`) until it appears
3. Attaches over CDP and injects a `window.testivaiWitness()` global into every page
4. When your tests call `window.testivaiWitness('name')` (via a small per-framework helper), the sidecar captures a screenshot + DOM and writes them to `.testivai/temp/<name>/`
5. After the test process exits, the sidecar finalizes: it runs `compareAll` and `generateReport`

It's the universal fallback for frameworks where TestivAI doesn't ship a dedicated adapter package.

## Why it's labeled experimental

The sidecar architecture has two structural pain points that no protocol switch (CDP → BiDi) fully fixes:

### 1. Browser launch coordination

Each test framework launches Chrome differently:

- **Cypress** spawns its own Chrome and historically didn't expose `--remote-debugging-port` cleanly without a plugin.
- **WebdriverIO** goes through Chromedriver — works but requires user-side capability config.
- **Selenium** needs `chromeOptions.add_experimental_option("debuggerAddress", ...)`.
- **Robot Framework / pytest / RSpec** — each has its own way.

So `testivai run` works **if** you configure your framework correctly, and the configuration is different per framework. That's a per-framework documentation + support burden, not a one-time fix.

### 2. Race conditions

The sidecar polls port 9222 for up to 60 seconds waiting for Chrome to appear. If your test framework launches Chrome late, or via a driver that doesn't open the port at all, the binding never attaches. The current code falls back to "continue without browser capture" — a polite way of saying "your snapshots are silently lost."

### 3. Multiple Chrome targets

A single Chrome process can have many tabs and iframes. The sidecar has to pick the right one. Cypress historically runs your tests inside an iframe inside a Cypress harness page — choose the wrong target and you capture the wrong DOM.

## When to use it anyway

The sidecar is genuinely useful when:

- You're running a framework with no adapter package today (Robot, Cucumber-Java, Selenium-Java without writing a Java SDK).
- You're prototyping and don't want to wire a service into your config.
- Your team already standardized on `--remote-debugging-port` for other tooling and the launch-coordination cost is already paid.

For Playwright and WebdriverIO, prefer the dedicated adapters:

- [`@testivai/witness-playwright`](./frameworks/playwright.md)
- [`@testivai/witness-webdriverio`](./frameworks/webdriverio.md)

They use the framework's native screenshot APIs, no port polling, no race conditions.

## Usage

```bash
npx testivai run "cypress run"
```

Your tests need a framework-specific helper that calls `window.testivaiWitness('name')`. The `testivai init` wizard generates these helpers under `testivai-witness.{js,py,rb,java}` for the framework you select.

```js
// Cypress
cy.window().its('testivaiWitness').then((witness) => witness('homepage'));

// WebdriverIO (when not using the adapter)
await browser.execute('return window.testivaiWitness(arguments[0])', 'homepage');

// Selenium / pytest
driver.execute_script("return window.testivaiWitness(arguments[0])", "homepage")
```

In local mode, the sidecar finalizes by running `compareAll` + `generateReport` — same as the dedicated adapters. Reports land in `visual-report/`.

## Roadmap

The sidecar stays in the OSS surface for fallback usage. We have no plans to remove it. We also have no plans to expand it to first-class status — the per-framework adapter pattern (proven by Allure, Percy, Applitools, Cucumber, Jest reporters) is what we're investing in for new frameworks.

If you want to take a non-JS framework first-class, see [`docs/extension-api.md`](./extension-api.md) for the on-disk contract — community adapters that conform to it work without any sidecar.
