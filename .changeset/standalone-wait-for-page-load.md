---
"@testivai/witness": patch
---

Standalone captures (`testivai witness <url>`) now wait for each page to load before preparing and capturing it. A new tab shows `about:blank`, which already reports itself loaded, until the page's response arrives. On the first page of a freshly launched Chrome, or on any page of a server that takes a moment to answer, the capture stabilization, the `ignoreSelectors` hiding, the web-font wait and the reveal-on-scroll pass all ran on `about:blank` and were lost, and the page was captured with its animations still running, so an unchanged page could be reported as changed. Crawling had the same gap and could read its links from `about:blank`. Each page now opens on `about:blank` at the capture viewport, is then navigated to its URL, and is prepared once that page has loaded, so it also never lays out at another viewport first.
