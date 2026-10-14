---
sidebar_position: 4
title: vs. rolling your own (Selenium)
---

# TestivAI vs. hand-rolled Selenium screenshot testing

Unlike Playwright, **Selenium ships no visual comparison at all.**
`driver.save_screenshot()` / `getScreenshotAs()` writes a PNG and stops there.
So the honest comparison isn't against a built-in feature — it's against the
200 lines almost every Selenium team ends up writing themselves.

## What everyone builds

The DIY version is genuinely reasonable, and it usually looks like this:

```python
# the shape of it, in every language
driver.save_screenshot("current.png")
baseline = Image.open("baselines/home.png")
current  = Image.open("current.png")
diff     = ImageChops.difference(baseline, current)
assert diff.getbbox() is None      # ...and then the questions start
```

Then the real work arrives:

- Byte equality fails on the first anti-aliasing difference, so you need a
  tolerance — and now you're picking a threshold with no way to tell a real
  change from render jitter.
- Baselines need a home, a naming scheme, and a per-OS story (a macOS baseline
  will not match a Linux CI runner, ever).
- Updating a baseline means copying files by hand, and the person who does it is
  usually the same person whose change caused the diff.
- CI needs the diff image *somewhere a reviewer can see it*.

Common escapes: **AShot** (Java, capture + comparison, widely used but no longer
actively maintained), **capybara-screenshot-diff** (Ruby),
**pytest-image-diff** / needle (Python), or a paid service like Applitools,
Percy, or Sauce Visual.

**If you have a working DIY setup covering a handful of pages and it doesn't
annoy you, keep it.** The diff is the easy part. TestivAI is the rest of it,
already built.

---

## What you get with the Selenium adapters

Verified against the adapter source, not aspirational:

| | |
|---|---|
| **Pixel diff + heatmap** | Difference magnitude rendered as a yellow→red heatmap over a washed baseline, with changed regions outlined. |
| **DOM + element map** | The page's DOM and per-element computed-style digests are captured next to the screenshot, so the report can tell *pixels differ, DOM and styles identical* (likely render noise) from *only the styles changed* (a real style-only change) and *the DOM actually changed* — with added / removed / attribute / text counts. When the styles could not be compared, it says so instead of calling the diff noise. |
| **Full-page screenshots** | Chromium via CDP `captureBeyondViewport`; Firefox natively (Python). Other browsers fall back to viewport — documented, not silent. |
| **Stabilization** | Animations and transitions collapsed, caret hidden, web fonts awaited before capture. |
| **Masks & ignored selectors** | Exclude dynamic areas; masked regions are hatched in the diff and listed in the report, so nothing hides silently. |
| **Baseline workflow** | `.testivai/baselines/` in your repo, `npx testivai approve` locally, or `/testivai approve` on a PR with the commenter's write access verified. |
| **Missing-baseline detection** | A baseline that received no capture is reported and exits `3` by default — a deleted test can't quietly stop guarding its page. |
| **One report across languages** | The JS, Python, and Java Selenium adapters write the same on-disk layout as the Playwright and WebdriverIO adapters. A mixed suite produces one baseline set and one report. |
| **Agent-readable** | `visual-report/results.json` plus [`@testivai/mcp`](./guides/ai-agents.md) for any MCP client. |

---

## Feature parity across languages

The three Selenium adapters now capture the same three artifacts —
`screenshot.png`, `dom.html`, and `elements.json` — so the full layered
analysis works in all of them:

| Feature | Selenium JS | Python | Java |
|---|---|---|---|
| Pixel diff + heatmap | Yes | Yes | Yes |
| DOM diff / noise hint / text changes | Yes | Yes | Yes |
| Region → selector attribution | Yes | Yes | Yes |
| Style-only-change verdict | Yes | Yes | Yes |
| Page-shift detection / `shiftTolerance` | Yes | Yes | Yes |

That last group depends on the **element map** — selectors, bounding boxes, and
computed-style digests collected from the live page. All adapters inject the
*identical* collector function: it is written once in TypeScript, and generated
into a JavaScript asset that the Python wheel and the Java jar ship. CI
regenerates it and fails on any difference.

This matters more than it might look. Every adapter writes into one shared
`.testivai/baselines/` directory, so a Python lane and a Java lane can compare
against the same baseline. If their collectors drifted apart, the same unchanged
page would produce different maps in different languages and the report would
show a regression that isn't there. One generated source makes that class of bug
unrepresentable.

Element-map capture is best-effort, exactly like the DOM snapshot: if a strict
Content-Security-Policy blocks the injected script, the capture still writes the
screenshot and DOM, and the report falls back to the pixel and DOM layers rather
than failing. Without the map, computed styles are not compared, so an
identical-DOM diff reads *styles not compared* (render noise or a
stylesheet-only change), never likely noise. Per-call escape hatches exist in every language
(`skipElementMap` / `skip_element_map` / `setSkipElementMap`), plus a
`maxElements` cap for very large pages.

**Ruby** has its own native adapter with the same capabilities — see the
[Ruby guide](./frameworks/ruby.md). Cypress, Puppeteer, and Robot Framework
still go through the experimental `testivai run` sidecar and do not capture the
element map.

**Maturity, plainly:** `@testivai/witness-selenium` is `0.1.x`, the Python
package is `0.1.0`, and the Java artifact is `0.1.0-SNAPSHOT` and
[not yet on Maven Central](./frameworks/java.md). The Playwright adapter is
`1.7.x` and considerably more exercised. Treat the Selenium lane as early — it
works and is tested, but it hasn't been through as many real suites.

---

## Side by side

| | Hand-rolled | AShot / image-diff libs | TestivAI |
|---|---|---|---|
| Pixel diff | Yes you write it | Yes | Yes |
| Diff image for review | you build it | Yes | Yes heatmap + regions |
| Tolerance / threshold | you tune it | Yes | Yes + auto-pass rules |
| Noise vs. real change | No | No | Yes via DOM diff + computed-style check |
| Text-change detection | No | No | Yes |
| Baseline store + approval flow | you build it | No | Yes CLI + PR command |
| Missing-baseline detection | No | No | Yes (exit 3) |
| Per-OS baselines | you build it | you build it | Yes `{platform}` token |
| Shared with other frameworks | No | No | Yes |
| Machine-readable output | No | No | Yes `results.json` + MCP |
| Selector attribution / style verdict | No | No | Yes (JS, Python, Java) |
| Cost | your time | free | free (MIT) |

---

## Choosing

**Stay hand-rolled if** you have a few screenshots, the diffs are rare, and a
human comparing two PNGs is a fine review process. That is a real, defensible
setup and you shouldn't replace it out of tidiness.

**Reach for TestivAI when** you're re-approving noise you can't distinguish from
regressions, when baseline updates need review by someone other than the author,
when a Linux CI runner disagrees with every laptop baseline, or when you're
maintaining the same 200 lines in two languages because your suite is part Java
and part Python.

→ [Selenium quickstart](./frameworks/selenium.md) ·
[Python](./frameworks/python.md) · [Java](./frameworks/java.md) ·
[Playwright comparison](./vs-playwright-builtin.md)
