---
sidebar_position: 9
title: Ruby (Capybara / RSpec)
---

# Ruby

Native adapter for **Capybara** and **Selenium** Ruby suites — no sidecar, no
Chrome debug port, no wrapper around your test command. You run
`bundle exec rspec` exactly as you do today.

New here? [vs. rolling your own](../vs-selenium-tooling.md) covers what this
replaces in a hand-rolled screenshot setup.

## Install

```ruby
# Gemfile
gem "testivai", group: :test
```

```bash
bundle install
```

## Capture

```ruby
require "testivai"

RSpec.describe "Homepage", type: :feature do
  it "looks right" do
    visit "/"
    Testivai.witness(page, "homepage")
  end
end
```

`Testivai.witness` accepts a Capybara session (`page`), a Capybara driver, or a
bare `Selenium::WebDriver` — it unwraps to the underlying browser itself.

Cucumber is the same call from a step definition:

```ruby
Then("the page looks correct") do
  Testivai.witness(page, "checkout")
end
```

## Compare

```bash
bundle exec rspec     # your suite, unchanged — captures land in .testivai/temp/
npx testivai report   # diff against baselines + write the HTML report
```

The first run creates baselines under `.testivai/baselines/` — commit them.
Later runs diff against them and write `visual-report/index.html`.

:::note Why Node for the report?
Capture is native Ruby. The diff engine, tolerances, and HTML report are shared
by every adapter and live in `@testivai/witness` — one comparison
implementation rather than five subtly different ones. The Python and Java
adapters split the same way. If a project has no Node, run
`npx --yes @testivai/witness report`.
:::

## Options

```ruby
Testivai.witness(page, "checkout",
  ignore_selectors: [".live-chat", "#clock"],  # hidden from pixels AND the DOM signal
  stabilize: true,        # freeze animations, hide caret, await web fonts
  skip_dom: false,        # the DOM snapshot powers the noise hint
  skip_element_map: false,# the element map powers selector attribution
  max_elements: 3000,     # cap for very large pages
  project_root: nil)      # defaults to the nearest ancestor holding .testivai/
```

Anything omitted falls back to `.testivai/config.json`, the same file every
other adapter reads.

## What gets captured

| File | Powers |
|---|---|
| `screenshot.png` | The pixel diff and heatmap |
| `dom.html` | DOM diff, noise hint, text-change detection |
| `elements.json` | Region→selector attribution, shift detection, style checks (an identical-DOM diff is *likely render noise* only when these styles match and the diff is small and scattered) |

Full-page capture uses Chromium's CDP `captureBeyondViewport` when the driver
exposes `execute_cdp`, Firefox's native full-page screenshot when available, and
falls back to a viewport capture otherwise — documented, never silent.

The element-map collector is generated from a single TypeScript source shared by
every TestivAI adapter, so a Ruby lane and a Python lane produce identical maps
against the same baselines.

DOM and element-map capture are both best-effort: if a strict
Content-Security-Policy blocks the injected script, the screenshot still lands
and the report falls back to the layers it does have. Without the element map,
computed styles are not compared, so an identical-DOM diff reads *styles not
compared* (render noise or a stylesheet-only change), never likely noise.

## Driver notes

Works with any Capybara driver that exposes `execute_script` — `selenium`
(Chrome, Firefox, Safari), Cuprite, Apparition. Rack-test has no browser and
cannot produce screenshots; use a real driver for visual specs:

```ruby
RSpec.describe "Homepage", type: :feature, js: true do
```

→ [Selenium](./selenium.md) · [Python](./python.md) · [Java](./java.md)
