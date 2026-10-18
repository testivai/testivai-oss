# Fixtures

Real `results.json` files used by the change-grouping tests. Only
`timestamp` and `baselineApprovedAt` were pinned to a fixed date; nothing else
was edited. Image paths are report-relative, as witness writes them.

Both were produced on 2026-10-04 from
[`testivai/testivai-example`](https://github.com/testivai/testivai-example) at
[`557cc4b`](https://github.com/testivai/testivai-example/commit/557cc4b) with
`@testivai/witness` 2.0.2 and `@testivai/witness-playwright` 2.0.2 packed from
this repository (`pnpm pack`, as in the CI consumer-install job), Playwright
1.63 and Chromium 141: capture baselines, change the `--brand` custom property
from `#0e7490` to `#1f6feb`, run again.

That commit is the example's earlier, single-page version. The example is now
a three-page static site with one snapshot per page, so running the same steps
on it today gives different results; these fixtures stay as recorded.

## `example-brand.results.json` (real)

The example project at that commit, unmodified apart from the token change.
Its three tests (`home`, `buttons`, `products`) captured the same full page,
so the three captures are byte-identical: one style-only change on six
elements, three times.

## `example-brand-synthetic-pages.results.json` (synthetic pages)

The same run plus four pages added locally for this design step only; they
are not part of the example repository. They share one stylesheet, so the
token change reaches each of them:

| Snapshot | What changed |
|---|---|
| `pricing` | the token, on a different DOM (header, plan prices, a primary button) |
| `about` | the token, on the header only |
| `team` | the token, plus an unrelated style change (`.person .role` font-size) |
| `contact` | the token, plus a structural change (one paragraph added) |

`home`, `buttons` and `products` are that version's single page, captured
again in this run (still byte-identical to each other).
