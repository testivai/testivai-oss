# @testivai/mcp

## 0.9.1

### Patch Changes

- 1ac04ef: Capture health: an unhealthy capture is never "render noise". A web font that failed and fell back to a system font, or a stylesheet that answered 404, leaves the DOM identical and the computed styles matching (the style digest hashes the declared `font-family`, not the font that rendered), so its small, scattered diff read "likely render noise" and `noiseAutoPass` passed it. The Playwright JS/TS adapter and `testivai witness <url>` now record, after each screenshot, what failed to load as `health` in the capture's `metadata.json`: `document.fonts.status` and every font face that errored, `<link rel=stylesheet>` elements that did not load, broken `<img>`s, and requests that answered 400 or more (Resource Timing, Chromium 109+), each URL as host and path only, never the query string. The crawler also merges the failed requests it saw on the network (CDP), cross-origin ones included. Approving freezes the capture's health into the baseline's `metadata.json`. results.json schema 2.7.0 (additive) adds `snapshots[].captureHealth` (both blocks, `unhealthy`: `"candidate"` / `"baseline"` / `"both"` / `null`, and `reasons` and `warnings` in plain words), present when either side recorded health, new snapshots included. Web fonts still loading, a font face that failed, a failed stylesheet, or a failed stylesheet request make a capture unhealthy (a failed font request only with a font face that failed, since a face can load from its next `src`; a `fetch()`/XHR request or a `<link>` that no `<link rel=stylesheet>` names and that does not end in `.css` is never a stylesheet): `dom.noiseHint` is then false and no pass criterion (`noiseAutoPass`, `maxDiffPercent` / `maxDiffPixels`, `shiftTolerance`) applies while pixels differ; a zero-pixel diff still passes. The HTML report, `@testivai/mcp` (`get_visual_results` verdicts, `explain_snapshot`'s new `layers.health` and guidance, the `triage-visual-diff` rubric and the review prompt; unhealthy captures are never grouped) and the GitHub Action comment read **Unhealthy capture** with what failed, before any other reading (rendering drift too, when both are true), and call out an unhealthy baseline on every compare against it ("re-baseline from a healthy run"). Broken images, failed scripts and other requests are warnings only. `testivai approve` warns when the capture it promotes is unhealthy. `@testivai/witness` exports `HEALTH_PROBE_EXPRESSION`, `parseHealth`, `mergeResourceFailures` and the types, and `@testivai/witness/report` the readings (`assessHealth`, `snapshotCaptureHealth`, `captureHealthReading`, `isUnhealthyCapture`, `approveHealthWarning`). The WebdriverIO, Selenium, Python, Ruby and Java adapters do not record health yet: their captures read "not checked" and compare exactly as before.
- e5f2b7f: `zod` 4.6.6 or later (was 3.25): every 3.x release is affected by GHSA-mrhx-c7xc-m3w5 (memory exhaustion while validating oversized constrained collections), so `npm audit --audit-level=high` failed in any project that installs `@testivai/mcp`. The tools, their arguments and their validation are unchanged. Two cosmetic differences in the advertised input schemas: integer arguments (`region`, `y`, `height`) now carry an explicit `maximum`, and tool input objects no longer advertise `additionalProperties: false` (unknown keys are still dropped, as before).
- c53604c: A permanently broken asset no longer turns off every pass tolerance. Since capture health (schema 2.7.0), no pass criterion passed an unhealthy capture whose pixels differed, so a site whose web font or stylesheet fails on every CI run lost `maxDiffPercent`, `maxDiffPixels` and `shiftTolerance` on every affected snapshot, and a small anti-aliasing diff failed even with the baseline unhealthy in the same way. Now, when both sides are unhealthy with exactly the same failures (the same font faces by family, weight and style, the same failed stylesheets, and the same failed stylesheet and font requests by host, path and status), results.json schema 2.8.0 (additive) sets `snapshots[].captureHealth.sameOnBothSides: true` and those three tolerances apply again (`autoPassed` `"threshold"` or `"shift"`). `noiseAutoPass` never passes an unhealthy capture, `dom.noiseHint` stays false, and the reading is still **Unhealthy capture**, never render noise: the HTML report, the `@testivai/mcp` verdicts, `explain_snapshot` guidance and triage rubric, and the GitHub Action comment add "the baseline was captured with the same failures", that the tolerances still apply but noise auto-pass does not, and which criterion passed it. It is never "the same" while web fonts were still loading on either side, when one side could see what the other could not (Font Loading API, request statuses), or when a list may have been cut at 10 entries; broken images and failed scripts are not compared (they are warnings). One side unhealthy, or different failures, behave as before. `@testivai/witness/report` exports `sameHealthFailures`, `healthAllowsTolerances` and `SAME_FAILURES_NEXT`; `parseReportData` keeps `sameOnBothSides` only as `true` with `unhealthy: "both"`.
- Updated dependencies [1ac04ef]
- Updated dependencies [a3278e1]
- Updated dependencies [c53604c]
  - @testivai/witness@2.6.0

## 0.9.0

### Minor Changes

- d8bd6b1: `get_diff` (and its alias `get_snapshot_diff`) now makes tall full-page captures readable. It still sends the baseline, current and diff images downscaled to fit (a 390×11844 mobile page becomes about 33×987 px, which shows where the changes are but not what they say), and then, when an image had to be downscaled, lists the snapshot's `regions` and crops them at native scale, one image pixel per page pixel, so a reviewer can check text, wrapping and clipping (a page that fits within 1024 px is already sent at native scale and gets no crops, as before). Each crop is a region plus 32 px on every side, made as wide as the page (up to 1280 px) so whole lines show, and labelled with its box and the region's selector; regions whose padded areas meet share a crop while it fits 1280×1024 px, a region inside a box another crop shows joins it, and changes come before shifts. The response stays bounded: up to 3 crops per call, each at most 1280×1024 px and 2,000,000 px in all; an area wider than 1280 px is sampled at 1/2 scale or smaller, and a taller one shows its top rows and gives the `y` to continue from. After a size change each capture is cut to its own bounds, and a crop of the padded band says the shorter capture has no pixels there. New optional inputs fetch one area on demand, without the full-page images: `region` (an index the response lists) or `y` and `height` (a full-width band, which works on a new snapshot too). An image that is not a PNG is now said instead of failing the call. The `triage-visual-diff` rubric, shared with the review action, tells the model to judge text, wrapping and clipping from the crops. Found when the review action triaged testivai/testivai-site#20 and could only judge one page, at thumbnail scale.

### Patch Changes

- cd9ffe7: Capture provenance: every capture now records where it came from, and the report says when a diff is the machine changing rather than the page. The Playwright, WebdriverIO and Selenium (JS) adapters and `testivai witness <url>` write an `environment` block into the capture's `metadata.json`: the OS (and the Linux distro), the browser and its version (and the WebDriver binary), the test framework, the adapter and how it took the screenshot (`full-page:cdp`, `full-page:playwright`, `full-page:stitched`, `viewport:webdriver`), what the page was rendered with (viewport, device scale, color scheme, reduced motion, locale, time zone, measured in the page), the CI provider and runner image, a container, and `TESTIVAI_ENV_LABEL`. Approving a capture freezes its block into the baseline's `metadata.json` (and drops a stale one). The compare reads both blocks: results.json schema 2.5.0 (additive) adds `snapshots[].environment` (`delta`, `renderingDelta`, both blocks when they differ) and a run-level `environment` (the fields every capture of the run agrees on). Framework, adapter and driver versions, the CI runner image, the project and the Linux kernel are context; the rest can change rendering. A diff whose DOM is identical, whose computed styles match and whose rendering environment changed is now **rendering drift** in the HTML report, `@testivai/mcp` (`get_visual_results` verdicts, its grouping and a new opening line when several snapshots share one change; `explain_snapshot`'s new `layers.environment`; the `triage-visual-diff` rubric) and the GitHub Action comment, never "likely render noise"; a size change from another capture method says so instead of "page grew". New config `environmentPolicy`: `"warn"` (default) never changes a status; `"separate"` keys snapshots `<name>__<browser>__<platform>` (never by version) and reports missing only the baselines of an environment the run captured; `"strict"` makes a rendering change of environment `changed` whatever its pixels say. New `testivai env` prints this machine's part of the block (`--fonts` adds a fingerprint of the installed fonts, `--json` for machines). `@testivai/witness` exports the collectors (`collectHostEnvironment`, `RENDER_PROBE_EXPRESSION`, `browserFromCapabilities`, `webDriverEnvironment`, `applyEnvironmentPolicyToName`, …) and `@testivai/witness/report` the readings (`diffEnvironments`, `isRenderingDrift`, `environmentChangeGroups`, `environmentChangeLine`, …). `BaselineStore` gains `writeTempMetadata` and `readTempMetadata`. The WebdriverIO and Selenium `WitnessBrowser` / `WitnessDriver` types gain the optional `capabilities` / `getCapabilities()` they read the browser from. The Python, Ruby and Java adapters do not record the block yet; their captures compare exactly as before.
- c439e08: The triage rubric (the `triage-visual-diff` prompt, shared with the review action) now says what an unchanged DOM rules out. No element, attribute or text differs between the baseline and the current capture, and the baseline is the last approved capture, which can already contain the change under test. So a text or markup edit in the change never explains an identical-DOM diff, even where its regions sit on text the change edited. Only something the DOM does not record can: a stylesheet change the style check does not cover, an image, a font or another asset, or the capture. When the change touched none of those, the verdict is a glitch or a possible bug, not an intended change. Found when the CI review of testivai-site#20 called a re-capture of already-approved copy an intended change because the pull request edited that text.
- Updated dependencies [cd9ffe7]
- Updated dependencies [c05d870]
  - @testivai/witness@2.5.0

## 0.8.3

### Patch Changes

- Updated dependencies [ebaf705]
  - @testivai/witness@2.4.0

## 0.8.2

### Patch Changes

- 0ec2cf8: A taller or shorter capture no longer reads as "content was added below the baseline's height". The padded band at the bottom of the diff is the page's new height, not where the change is: a banner inserted near the top makes the page taller too. The report verdict and the MCP verdict and guidance now read a height change with the page shift and the DOM signal, through the new shared `explainHeightChange` in `@testivai/witness/report`: a page shift places the change ("everything below y=203 moved down 73 px, so look above that line"), a DOM change says what changed but not where, and an identical DOM is the same content laid out taller or shorter (restyled when the computed styles differ, otherwise often fonts or rendering that differ between machines), never content added or removed. Before, an identical DOM read "the extra height is layout, not new elements: content was added". Found by running testivai-example's demo (an inserted banner) and its suite against baselines captured on another machine (pages 5 and 10 px taller, DOM and styles identical).
- Updated dependencies [0ec2cf8]
  - @testivai/witness@2.3.1

## 0.8.1

### Patch Changes

- f538f0c: A capture whose dimensions differ from its baseline's is now always reported as changed. `compareAll` sized the diff canvas to the baseline and truncated the candidate to it, so a page that grew (content added below the fold) had an identical overlap, `diffCount: 0`, and was passed at 0% while the DOM diff said elements were added; a different width misaligned every row into a nonsense diff. The two captures are now padded to the larger width and height, every padded pixel counts as changed and is painted as heat in the diff image (the engine's `diff()` takes the new `dimensions` option for that, so a width difference normalizes too; with `handleSizeMismatch: 'pad'` the engine now counts the padded pixels in `diffCount` on its older length-inferred path as well), and the result records both sizes as `sizeMismatch` (results.json schema 2.4.0, additive). No pass criterion (`maxDiffPercent`, `maxDiffPixels`, `noiseAutoPass`, `shiftTolerance`, or the zero-count pass) applies to a snapshot with `sizeMismatch`; a byte-identical capture still takes the fast path, and a DOM change on its own still never decides the status (the pixel tolerances stay pixel tolerances). A passed snapshot whose DOM changed, with nothing visible or within a tolerance, now says so in the report and the MCP verdict and guidance instead of asking to confirm before approving. The report row shows both sizes (`baseline 1280×2348 → current 1280×2538 (+190 px)`), and the verdict says what the change means: a taller or shorter page is content added or removed, with the DOM summary; a width change is almost always the viewport or device scale factor, not the page. `@testivai/witness/report` exports the shared wording (`describeSizeChange`, `formatSizeMismatch`, `formatSizes`, `sizeMismatchKind`). In `@testivai/mcp`, `get_visual_results` gives such a snapshot the size verdict before any other reading, `explain_snapshot` carries the two sizes in the pixel layer and leads its guidance with them, and a snapshot whose dimensions changed is never grouped with others, since its pixel signals describe the padding.
- Updated dependencies [f538f0c]
  - @testivai/witness@2.3.0

## 0.8.0

### Minor Changes

- 8f3f72c: Cover missing baselines: names in results.json `missingBaselines`, committed baselines that got no capture this run (the test was removed, renamed or skipped, or failed before it captured). `get_visual_results` counts them in its header and gives each one a verdict line saying there is nothing to approve and how to accept a removal; `explain_snapshot` returns status `missing` with the committed baseline files (found through `baselinesDir`, `{platform}` included) and what to check instead; `get_diff` returns the committed baseline screenshot only. The `triage-visual-diff` rubric gets a row for them (intended change, bug or possible bug, never a glitch), its next steps say an intended removal deletes the baseline directory because approving does nothing, and `review-visual-changes` no longer stops when the only finding is a missing baseline. A name is looked up only when results.json lists it as missing, and never resolves outside the baselines directory. With several missing baselines, `get_visual_results` gives the verdict once and a short line per name, so a partial run (`--grep`, a matrix lane) stays small; a baseline directory that is not on this machine (stale results, or another platform's `{platform}`) is said, with no removal command. `explain_snapshot` for a new snapshot names the missing baselines it may replace (a rename). `review-visual-changes` explains missing baselines in step 2 and offers deleting one, not approving it, in step 4. The removal command in the next steps names the project's own baselines directory. With no `snapshot` argument, `triage-visual-diff` now triages new snapshots too, as the CI review already did, as well as missing baselines.

### Patch Changes

- Updated dependencies [18ef81d]
  - @testivai/witness@2.2.1

## 0.7.0

### Minor Changes

- 23c126e: An identical DOM with matching computed styles is no longer called likely render noise when the diff is concentrated in one area or large. The style check covers a fixed list of properties, so a real change to size, overflow, transform or an image, or a bad capture, looks the same to it; render noise is small and scattered.

  - `get_visual_results`, `explain_snapshot`, the change groups and the `review-visual-changes` prompt give a diff whose regions all fit in a box covering at most a third of the page its own verdict, which names the regions and their box: "a bad capture, or a change the style check does not cover; compare the images (get_diff) before approving". A spread-out diff over 1% of pixels gets a "large" verdict that says the same. On real runs, the clipped product card from the `triage-visual-diff` eval (0.03% of pixels, 3 regions in 0.8% of the page), a capture whose card text did not paint and a baseline with a shifted band no longer read as noise; scattered text-rendering noise still does.
  - `explain_snapshot` adds `layers.pixel.shape` (`scattered`, `concentrated` or `large`, with the regions' box and its share of the page) and, for a concentrated diff, names the element every region maps to.
  - Concentrated diffs are never grouped (each sits in its own area); large ones get their own `large-diff` group, apart from noise.
  - A `noise` auto-pass of a concentrated diff from an older witness says to look at the diff.

  The rule comes from `diffShape` in `@testivai/witness`, read from `results.json` fields older versions already write, so it applies to existing results too.

- d9d07de: New `triage-visual-diff` prompt: the model sorts each changed snapshot into glitch (the capture or environment, not the page), intended change, bug or possible bug, from `explain_snapshot`, the `get_diff` images and what the change was meant to do (optional `snapshot` and `intent` arguments). A changed DOM or changed computed styles is never a glitch, an identical DOM whose styles were not compared is not called one from the DOM alone, and a large or local DOM-identical diff is a bad capture (say which image) only when nothing the change touched could have caused it, since the style check does not cover every CSS property. The prompt never approves. `prompts/get` also accepts a request with no `arguments` object, which MCP allows and the SDK rejected for prompts with optional arguments. The same rules run in CI through the new `testivai/testivai-oss/review@v1` action.

### Patch Changes

- 34d7304: The MCP server no longer tells agents that an identical-DOM diff is likely render noise when the computed styles were not compared. `get_visual_results`, `explain_snapshot`, the change groups and the `review-visual-changes` prompt give that case its own "styles not compared" verdict and send the agent to the images (`get_diff`) before approving. An auto-passed snapshot names the criterion that passed it, a passed snapshot no longer gets noise guidance, and a DOM change that also restyled elements is never described as "the DOM stayed identical".
- Updated dependencies [23c126e]
- Updated dependencies [b3fb0e6]
- Updated dependencies [34d7304]
  - @testivai/witness@2.2.0

## 0.6.1

### Patch Changes

- Updated dependencies [10dc7d3]
  - @testivai/witness@2.1.1

## 0.6.0

### Minor Changes

- b2892e5: Turn off the per-call approval prompt when you want to. By default `approve_snapshot` and `approve_all` make Claude Code ask you on every call. Start the MCP server with `--no-approval-prompt`, or set `"mcpApprovalPrompt": false` in `.testivai/config.json`, and the approve tools follow your client's own permission settings instead (allow rules, "don't ask again", auto modes). The flag wins over the config key, and `--approval-prompt` turns the prompt back on. `@testivai/witness` now recognises `mcpApprovalPrompt` as a boolean config key instead of warning that it is unknown.
- a3e909d: Approve visual changes from Claude Code, with the approval always coming from you. `approve_snapshot` and `approve_all` now carry `anthropic/requiresUserInteraction` in `tools/list`, so Claude Code (v2.1.214 or later) shows its permission prompt on every approve call, even in `acceptEdits`, `auto` and `bypassPermissions` modes, with no "don't ask again"; other MCP clients ignore the marker. The `get_visual_results` footer still tells the agent not to approve on its own, and now names `approve_snapshot` for when the human confirms a change in the conversation, alongside `npx testivai approve` and `/testivai approve` on the PR.
- 067eecc: `get_visual_results` now groups snapshots that share an identical signal before listing them one by one: a style-only change on exactly the same set of elements, the same page shift (`dy` and `belowY`), or the same kind of render noise (styles compared and matching, or not compared). The grouping is deterministic and does not depend on input order. It never groups structural DOM changes, snapshots without DOM data, or style-only changes whose element list witness truncated at 10 (those are named instead), and each group says exactly what it was based on: for a style-only group, which elements changed style, not the new style values. The per-snapshot verdict lines are unchanged.
- 26f982a: `get_visual_results` now ends with the paths you can open to see what changed: the HTML report, each changed snapshot's diff image, and each new snapshot's capture, as absolute paths. MCP clients give images to the model, but may not show them to you; these paths let you open them from the conversation. The per-snapshot verdict lines are unchanged, and only files that exist inside the report directory are listed.

### Patch Changes

- 1e83349: The agent-facing text no longer contradicts the verdicts. The `get_visual_results` description, which the model reads before calling the tool, said "DOM-identical diffs are likely render noise", but since witness 1.6.0 a diff with an identical DOM and different computed styles is a real style-only change, and the verdict already said so. The description now ties noise to the DOM and the computed styles both matching. The noise verdict, and the matching `explain_snapshot` guidance, now say the DOM and computed styles both matched when the style check ran, and say the styles were not compared when it could not run (no comparable style digests), instead of implying a match that was never checked.
- Updated dependencies [b2892e5]
- Updated dependencies [b380f3c]
  - @testivai/witness@2.1.0

## 0.5.10

### Patch Changes

- Updated dependencies [fcd39f8]
  - @testivai/witness@2.0.2

## 0.5.9

### Patch Changes

- Updated dependencies [e289450]
  - @testivai/witness@2.0.1

## 0.5.8

### Patch Changes

- Updated dependencies [5af0816]
- Updated dependencies [ec92541]
  - @testivai/witness@2.0.0

## 0.5.7

### Patch Changes

- 01232e8: When no report exists, the MCP server now explains why instead of always saying "run the visual tests first" — which is wrong on a sharded CI node, where the tests did run but a shard captures without comparing. It distinguishes a capture-only shard (naming which), captures that were never compared, and a project where nothing ran at all.
- Updated dependencies [f80f6c6]
- Updated dependencies [09eafd4]
- Updated dependencies [6fdc1db]
  - @testivai/witness@1.13.0

## 0.5.6

### Patch Changes

- 1efe97f: Fixes the agent-facing verdict for style-only changes. When the DOM was identical but computed styles differed, `explain_snapshot` and `get_visual_results` reported "no DOM data; treat as needing human review" — contradicting the HTML report, which correctly calls it a style-only change, and hiding the signal agents most need. Verdicts now say "style-only change: N elements restyled with identical DOM" with the affected selectors, and a captured-but-unremarkable DOM no longer claims to be missing. Adds a dedicated MCP documentation page.
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

## 0.5.5

### Patch Changes

- Updated dependencies [b70ebd9]
  - @testivai/witness@1.11.1

## 0.5.4

### Patch Changes

- Updated dependencies [f94048d]
- Updated dependencies [8de6c13]
  - @testivai/witness@1.11.0

## 0.5.3

### Patch Changes

- Updated dependencies [271f30d]
  - @testivai/witness@1.10.0

## 0.5.2

### Patch Changes

- 381279b: `list_baselines` (and the approve tools via the shared store) now honor the `baselinesDir` config, including the new `{platform}` token — agreeing with the CLI's resolution.
- Updated dependencies [381279b]
  - @testivai/witness@1.9.0

## 0.5.1

### Patch Changes

- Updated dependencies [139d28d]
- Updated dependencies [1c4c883]
  - @testivai/witness@1.8.0

## 0.5.0

### Minor Changes

- e37eb33: New `explain_snapshot(name)` tool: a layered evidence bundle for one snapshot — pixel regions with bounding boxes, element attribution (which selectors shifted vs changed, whole-page shift detection), the DOM/style signal, and interpretation guidance. Paired with a new `review-visual-changes` prompt that walks any MCP client through a full review (summary → explanations → diff images → per-snapshot recommendation). The client's own model writes the narrative; the server ships evidence, not an LLM.

### Patch Changes

- Updated dependencies [fa0deb5]
- Updated dependencies [e37eb33]
  - @testivai/witness@1.7.1

## 0.4.0

### Minor Changes

- 5bfdca5: The MCP server can now drive the full agent loop without scraping ANSI output:

  - `approve_snapshot(name)` and `approve_all` promote captures in `.testivai/temp/` to committed baselines, reusing the same `BaselineStore` as the CLI (identical semantics + undo).
  - `get_report` returns the raw `results.json` payload (summary + per-snapshot status, diff %, DOM signal, region→selector attribution) for structured parsing.
  - `get_diff` is added as the canonical name for the diff-image tool; `get_snapshot_diff` remains as an alias.

  Approval tools are gated by intent in their descriptions: only approve changes a reviewer has confirmed are intended.

### Patch Changes

- Updated dependencies [5bfdca5]
- Updated dependencies [9db57c2]
  - @testivai/witness@1.7.0

## 0.3.0

### Minor Changes

- 767385e: The `get_snapshot_diff` tool now downscales returned diff images to a max 1024px longest edge (integer-stride nearest-neighbour, via `pngjs`). When an image was downscaled the text label includes the original dimensions (e.g. "baseline (downscaled from 1280x7669):"). Images that already fit within 1024px are returned unchanged.

### Patch Changes

- 9bbbd58: Add official MCP Registry metadata: `mcpName` (`ai.testiv/mcp`, DNS-verified namespace) in package.json and a `server.json` descriptor, so the server can be listed on registry.modelcontextprotocol.io.

## 0.2.0

### Minor Changes

- fed09cf: New package: MCP (Model Context Protocol) server exposing TestivAI visual regression results to AI coding agents. Read-only v1 with three tools: `get_visual_results` (per-snapshot verdicts combining pixel diff + DOM signal), `get_snapshot_diff` (returns baseline/current/diff images so the agent can see the change), and `list_baselines`. No approve tool by design — baseline promotion stays a human decision.
