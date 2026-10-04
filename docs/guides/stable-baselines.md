---
sidebar_position: 6
title: Stable Baselines
---

# Stable Baselines

Flaky visual tests waste everyone's time. A screenshot that fails because a
third-party ad loaded a different image, or because a font hadn't finished
rendering, is noise — not a regression. This guide covers the built-in tools
that keep your baselines clean and your diffs meaningful, all configurable
from `.testivai/config.json`.

---

## Animation & transition freezing

The SDK **automatically** freezes animations, transitions, and the blinking
caret before every capture. No setup required.

Under the hood, the adapter injects a stabilizing `<style>` block that pauses
CSS animations/transitions and hides the caret, then waits for in-flight web
fonts to finish loading before the shutter fires.

This is controlled by the `stabilize` option — on by default:

```json
{
  "stabilize": true
}
```

Set it to `false` only when you explicitly want to capture mid-animation
states (e.g. a loading spinner snapshot).

---

## `ignoreSelectors` — hide dynamic elements

Some page regions change on every run and are irrelevant to your visual
baseline: timestamps, live-chat widgets, rotating ad banners, "last updated"
badges. `ignoreSelectors` lets you blank those elements before the capture
so they never contribute to the diff.

### Two modes

Every entry in `ignoreSelectors` supports one of two modes, controlling
*how* the element is neutralized:

| Mode | CSS | Effect |
|------|-----|--------|
| `mask` (default) | `visibility: hidden !important` | Blanks the element but **keeps its layout** — the box still occupies space |
| `collapse` | `display: none !important` | **Removes layout influence** — everything below shifts up |

### When to use each

- **`mask`** — for image/avatar/ad content inside a stable-width container.
  The box stays put so the rest of the layout doesn't shift. Ideal for
  `<img>` tags, `<svg>` icons, and inline badges whose container size is
  predictable.
- **`collapse`** — for variable-height dynamic content like a footer whose
  height changes between runs, or an injected alert bar that appears
  sometimes but not always. If you don't remove its layout influence,
  everything below it shifts and the diff lights up.

### Config shapes

All three forms are valid and can be mixed in the same array:

**Bare strings** (default to `mask`):

```json
{
  "ignoreSelectors": ["#live-chat", ".timestamp", "[data-testid='ad-banner']"]
}
```

**Object with explicit mode:**

```json
{
  "ignoreSelectors": [
    { "selector": "#footer", "mode": "collapse" },
    { "selector": ".ad-container", "mode": "mask" }
  ]
}
```

**Mixed array:**

```json
{
  "ignoreSelectors": [
    "#live-chat",
    { "selector": "#footer", "mode": "collapse" },
    ".version-badge",
    { "selector": ".alert-bar", "mode": "collapse" }
  ]
}
```

Selectors are deduplicated across sources (global config, project config,
per-snapshot calls) — the first occurrence wins.

### Where to set them

`ignoreSelectors` can be defined in three places, merged first-write-wins:

1. **`.testivai/config.json`** — global for the repo (recommended for shared
   dynamic chrome)
2. **`testivai.config.ts`** — per-project overrides
3. **Per-snapshot call** — one-off exclusions for a specific `testivai.witness()`

---

## Quick-reference recipe table

| Problem | Fix | Why |
|---------|-----|-----|
| Dynamic text (timestamps, emails, counters, "ago" strings) | `ignoreSelectors` with `mask` | Blanks the text while preserving the surrounding layout |
| Data-dependent table/list heights that vary across runs | `ignoreSelectors` with `collapse` | Removes the element from flow so the rest of the page stays aligned |
| Image/avatar/ad content changing inside a stable container | `ignoreSelectors` with `mask` | Hides the variable content, keeps the container box |
| Cross-machine anti-aliasing or font-rendering differences | Tune `threshold` or enable `noiseAutoPass` | The DOM noise hint already flags these ("pixels differ but DOM and styles unchanged"); let tolerance auto-pass them |

:::tip DOM noise hint
When the pixel diff is non-zero but the DOM is structurally identical and no
computed-style change was found, the report labels the snapshot with a
**noise hint**. (A style-only change, with identical DOM and different computed
styles, is labelled as a real change instead.) The noise hint usually means font
rendering, sub-pixel anti-aliasing, or GPU-level differences — not a real
visual regression. Use `noiseAutoPass` to let these auto-pass up to a
`noiseMaxDiffPercent` ceiling.
:::

---

## Global config (`.testivai/config.json`)

The `.testivai/config.json` file at your project root is the single source of
truth for local-mode settings. Every field is optional and falls back to a safe
default — and so is the file itself: with no `config.json` at all, the defaults
below apply unchanged.

### General

| Field | Type | Default | Description |
|-------|------|---------|-------------|

### Diff tolerance

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `threshold` | `number` (0–1) | `0.1` | Per-pixel tolerance. Pixels differing by less than this fraction (0.1 = 10%) are considered identical |
| `maxDiffPercent` | `number` (0–100) | `0` | Snapshots whose total diff percentage is at or below this value report as **passed**. Default 0 = only pixel-perfect passes |
| `maxDiffPixels` | `number` | unset | Absolute variant: pass when changed-pixel count is at or below this. When both are set, satisfying **either** passes |
| `noiseAutoPass` | `boolean` | `false` | Auto-pass diffs whose DOM is structurally identical (the noise hint), up to `noiseMaxDiffPercent` |
| `noiseMaxDiffPercent` | `number` (0–100) | `1` | Upper diff-% bound for `noiseAutoPass`. DOM-identical diffs larger than this still show as changed |
| `shiftTolerance` | `number` (px) | off | Auto-pass when every diff region is a pure element shift within this many px per axis — kills sub-pixel layout jitter (labeled `autoPassed: "shift"`, auditable in the report) |
| `diffRegions` | `object` | `{ minSize: 10, mergeDistance: 12 }` | Diff clustering: `minSize` = noise floor in pixels, `mergeDistance` = px gap for merging nearby diff regions |

### Capture behavior

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `stabilize` | `boolean` | `true` | Freeze CSS animations/transitions, hide the caret, and wait for web fonts before every capture |
| `ignoreSelectors` | `(string \| { selector, mode })[]` | `[]` | Elements to hide during capture. Bare strings default to `mask` mode |
| `mask` | `(string \| object)[]` | `[]` | Page areas excluded from the pixel diff and hatched in the report. Supports CSS selectors and geometric regions |

### Output & workflow

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `reportDir` | `string` | `"visual-report"` | Directory for the self-contained HTML diff report |
| `autoOpen` | `boolean` | `true` | Automatically open the HTML report in your browser after a run |
| `failOnDiff` | `boolean` | `false` | When `true`, exit with a non-zero code if any diffs are detected (useful in CI) |
| `failOnMissing` | `boolean` | `true` | Exit `3` from `testivai report` when a baseline received no capture this run — silent coverage loss. Set `false` (or pass `--allow-missing`) for filtered runs |
| `shareUploadCommand` | `string` | — | Storage-agnostic upload hook for `report --share`: shell command with `{file}` placeholder; last stdout line is the shared URL (`aws s3 cp …`, `gsutil`, `rclone`, `curl`) |
| `volatileAttributes` | `string[]` | `[]` | Attribute names whose *values* the DOM diff ignores (presence still counts) — for per-run URLs in `src`/`srcset` that otherwise poison the noise hint. `blob:` URLs are always normalized |
| `baselinesDir` | `string` | `.testivai/baselines` | Where baselines live. Supports a `{platform}` token (`darwin`/`linux`/`win32`) for per-OS baselines |
| `mcpApprovalPrompt` | `boolean` | `true` | Read by [`@testivai/mcp`](../mcp.md#turning-the-approval-prompt-off): the approve tools ask a person on every call (Claude Code shows its permission prompt even in auto-approving modes). `false` lets them follow the client's own permission settings. The server's `--approval-prompt` / `--no-approval-prompt` flag overrides it |

### Standalone mode (`testivai witness <url>`)

These apply only to the no-test-suite crawler; framework adapters ignore them.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pages` | `string[]` | unset | Explicit page paths to capture, resolved against the start URL (e.g. `["/", "/pricing"]`). When set, link crawling is skipped |
| `maxPages` | `number` | `10` | Cap on pages discovered when crawling same-origin links from the start page |
| `viewport` | `{ width, height }` | `1280x800` | Capture viewport |

### Complete example

```json
{
  "threshold": 0.1,
  "reportDir": "visual-report",
  "autoOpen": true,
  "failOnDiff": false,
  "stabilize": true,
  "maxDiffPercent": 0,
  "noiseAutoPass": false,
  "noiseMaxDiffPercent": 1,
  "ignoreSelectors": [
    "#live-chat",
    ".timestamp",
    { "selector": "#dynamic-footer", "mode": "collapse" }
  ],
  "mask": [
    "[data-testid='user-avatar']"
  ],
  "diffRegions": {
    "minSize": 10,
    "mergeDistance": 12
  }
}
```

`npx testivai init` scaffolds a smaller version of this file — only the
defaults (`mode`, `threshold`, `autoOpen`, `failOnDiff`, `failOnMissing`,
`maxDiffPercent`, `noiseAutoPass`, `noiseMaxDiffPercent`, `stabilize`). The
example above adds the optional keys (`reportDir`, `ignoreSelectors`, `mask`,
`diffRegions`) that you opt into by hand. Delete any field you don't need —
every key falls back to its default.


## Waiting for the page to settle

Before every capture, `stabilize` (on by default) freezes animations and
transitions, hides the caret, disables smooth scrolling, waits for web fonts —
and then waits for the page to **stop changing**:

- `document.readyState === 'complete'`
- every `<img>` finished (a failed image counts as finished, so a 404 never hangs you)
- no DOM mutations for 150ms, watched with a `MutationObserver`

All of it is bounded at 5 seconds. A page that never settles gets captured
anyway rather than hanging the suite, and `TESTIVAI_DEBUG=true` says so.

### Why not "network idle"

Playwright's own documentation marks `networkidle` **DISCOURAGED**: *"Don't use
this method for testing, rely on web assertions to assess readiness instead."*
It is also the wrong signal for a visual snapshot — a page with analytics
beacons or long-polling never goes quiet even though it is visually settled,
while a network-idle page can still be mid-animation. What matters for a
screenshot is whether the *rendered page* stopped changing.

The observer approach also stays out of your application's way: a
`MutationObserver` watches, where a network monitor would have to monkey-patch
`fetch` and `XMLHttpRequest` in the page under test.

### What this cannot do

It waits for work the page has **started**. It cannot wait for content the page
has not requested yet — an image whose `src` is set by a timer three seconds
later looks identical to a page that is simply finished.

No tool can know that without knowing your app, which is exactly why Playwright
points at web assertions. If content arrives on a delay, assert it before
capturing:

```ts
await expect(page.getByTestId('chart')).toBeVisible();
await witness(page, testInfo, 'dashboard');
```

That is a real limitation, not a rough edge — the settle wait removes the flake
you get from *in-flight* loading, which is the common case.

## Repository size — what baselines actually cost

Baselines are PNGs committed to your repository, so it's fair to ask what that
does to clone times. Measured numbers rather than reassurance:

- A full-page screenshot of a straightforward page is around **175 KB**.
- Re-approving one stores a **second full copy**. Two different versions of the
  same screenshot measured 355,259 bytes raw and 342,845 bytes packed — git's
  delta compression saved **3.5%**. PNG is already deflate-compressed, so there
  is almost nothing left for git to squeeze.
- Identical images cost nothing extra. Git is content-addressed, so two snapshot
  names capturing the same pixels share one object.

The arithmetic that follows: a 50-snapshot suite is roughly **8.5 MB** on the
first commit, and every round of approvals adds about another 8.5 MB to history
permanently. That's fine for years on a normal project. It becomes a problem
when approvals are frequent *and* the suite is large.

### Keeping it small (do these before reaching for LFS)

1. **Approve deliberately.** Most growth comes from re-approving everything when
   only a few snapshots genuinely changed. `npx testivai approve <name>` beats
   `--all` as a habit.
2. **Cut the churn at the source.** `ignoreSelectors` and `mask` on timestamps,
   carousels and live widgets stop snapshots changing for reasons nobody cares
   about — every avoided approval is a copy you never store.
3. **Capture what you're actually testing.** A component or above-the-fold
   capture is a fraction of a full-page shot of a long marketing page.
4. **Shallow-clone in CI.** `fetch-depth: 1` (the default for
   `actions/checkout`) means CI never pays for history at all.

### Should you use Git LFS?

**Usually no**, and this is a genuine recommendation rather than a hedge:

- On GitHub, LFS has storage and bandwidth quotas that **cost money** past the
  free tier, and visual baselines are exactly the kind of asset that burns
  bandwidth on every CI run.
- **It breaks the fork workflow.** Forks don't inherit LFS budget, so
  contributors to a public repository may be unable to fetch your baselines —
  which defeats the point of committing them.
- Everyone, including CI, needs `git-lfs` installed and `lfs: true` on checkout.
  It's one more thing to go wrong in someone's first five minutes.

LFS earns its keep when the repository is **private**, the suite is **large**
(hundreds of snapshots), and approvals are **frequent** — that combination is
where plain git genuinely strains. Below it, the four steps above are cheaper
and have no failure modes.

If history has already grown past comfort, the fix is a one-off history rewrite
(`git filter-repo`) rather than migrating to LFS, which doesn't shrink anything
already committed.

## Cross-platform baselines

Font rasterization differs between macOS, Linux, and Windows — a baseline captured on a Mac laptop will flag on a Linux CI runner forever. Two good setups:

**1. One gating platform (simplest).** Let CI (Linux) own the baselines: capture and approve them from CI via the [GitHub Action](/github-action)'s `/testivai approve` flow, and treat local runs as advisory.

**2. Per-platform baselines.** Give each OS its own baseline set with the `{platform}` token:

```json
{
  "baselinesDir": ".testivai/baselines-{platform}"
}
```

Mac devs gate against `baselines-darwin/`, CI gates against `baselines-linux/` — both committed, no cross-OS noise. Remember each platform's baselines must be approved from a run on that platform.

## Volatile attributes

If your app rewrites `src`/`srcset`/`href` per run (CDN hashes, signed URLs), the DOM diff sees `attributeChanges: 1` and withholds the render-noise hint even for pure anti-aliasing diffs. Declare those attributes volatile:

```json
{
  "volatileAttributes": ["src", "srcset"]
}
```

The attribute's *presence* still counts (removing an image is a real change); only its value churn is ignored. `blob:` object URLs are always normalized — they are per-session by construction — while `data:` URIs stay significant because they encode content.
