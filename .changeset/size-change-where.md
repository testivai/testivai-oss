---
"@testivai/witness": patch
"@testivai/mcp": patch
---

A taller or shorter capture no longer reads as "content was added below the baseline's height". The padded band at the bottom of the diff is the page's new height, not where the change is: a banner inserted near the top makes the page taller too. The report verdict and the MCP verdict and guidance now read a height change with the page shift and the DOM signal, through the new shared `explainHeightChange` in `@testivai/witness/report`: a page shift places the change ("everything below y=203 moved down 73 px, so look above that line"), a DOM change says what changed but not where, and an identical DOM is the same content laid out taller or shorter (restyled when the computed styles differ, otherwise often fonts or rendering that differ between machines), never content added or removed. Before, an identical DOM read "the extra height is layout, not new elements: content was added". Found by running testivai-example's demo (an inserted banner) and its suite against baselines captured on another machine (pages 5 and 10 px taller, DOM and styles identical).
