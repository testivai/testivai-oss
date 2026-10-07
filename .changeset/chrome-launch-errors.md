---
"@testivai/witness": patch
---

Standalone capture (`testivai witness <url>`) now says why Chrome failed to start. Chrome's stderr used to be discarded and the launcher always waited a fixed 12 seconds, so a crash and a slow start produced the same "did not open its debugging endpoint within 12s" error. A Chrome that exits is now reported straight away with its exit code and the end of its stderr (for example "Running as root without --no-sandbox is not supported"). The wait for a slow start defaults to 30 seconds and can be changed with `TESTIVAI_CHROME_STARTUP_TIMEOUT_MS`.
