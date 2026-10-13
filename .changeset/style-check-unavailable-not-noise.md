---
"@testivai/witness": minor
---

An identical DOM is no longer called likely render noise unless the computed styles were compared and matched.

- **`noiseAutoPass` now requires a style match.** It passes a diff only when the DOM is identical **and** `dom.styleCheck` is `"match"` (still within `noiseMaxDiffPercent`). A snapshot whose styles were not compared (`"unavailable"`, or no `styleCheck` in an older results.json) stays `changed` for a human, so a stylesheet-only change can no longer auto-pass silently. This matters for captures without an element map: the standalone crawler (`testivai witness <url>`), the `testivai run` sidecar, playwright-python and playwright-java. The `@testivai/witness-playwright`, `-webdriverio` and `-selenium` adapters (and Selenium for Python and Java) record styles and behave as before.
- **The HTML report has a third verdict, "Styles not compared".** It means the DOM is identical but the computed styles were not compared, so it could be render noise or a stylesheet-only change: compare the images before approving. The likely-noise verdict and badge now appear only when the styles matched, and say so.
- A DOM change that also restyles elements (for example a `class` attribute change) now reads as a structural change that names the restyled elements, instead of "style-only change … identical DOM".
- The report sidebar, the auto-pass note and the config docs say what is true: captures are stabilized by default, other dynamic content needs `ignoreSelectors`/`mask`, and noise is labelled, not removed.

`results.json` is unchanged: `dom.noiseHint` still means "DOM identical and no style mismatch found"; read it together with `dom.styleCheck`.
