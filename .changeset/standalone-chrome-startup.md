---
"@testivai/witness": patch
---

`testivai witness <url>`: the headless Chrome it launches picks a free debugging port itself (`--remote-debugging-port=0`, read back from `DevToolsActivePort`). The port used to be random in 9222–10021 and never checked, so a port another process held made the run wait 30s and fail. A Chrome that has not opened its debugging endpoint by half of `TESTIVAI_CHROME_STARTUP_TIMEOUT_MS` (default 30s) is stopped and launched once more, with a warning quoting its stderr; if both launches stall, the error says so and quotes both. A Chrome that exits still fails at once. `--port` (reuse a running Chrome) is unchanged.
