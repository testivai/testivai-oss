---
"@testivai/witness": minor
"@testivai/witness-playwright": patch
---

A failing test no longer leaves a pull request without a visual report. `testivai merge-captures` now writes `testivai-merge.json` beside the captures it merges in `.testivai/temp/` (the shard total, the shards seen and the shards missing; exported as `MERGE_RECORD` and the `MergeRecord` type), so a later step can tell a merge that lacks a shard from the whole suite. The `testivai/testivai-oss@v1` action uses it: when a run wrote no `results.json`, the action compares the captures in `.testivai/temp/` itself, but never one shard's slice or an incomplete merge. In capture-only mode, the Playwright reporter's hint now says to run the compare step with `if: ${{ !cancelled() }}` (and on a job that `needs` the shards, too), since a CI step runs only on success by default.
