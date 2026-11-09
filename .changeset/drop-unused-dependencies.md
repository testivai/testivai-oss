---
"@testivai/witness": patch
---

Drops two runtime dependencies that nothing imported: `ora` (unused since the package was split out; its engines field asked for Node 20) and `ws` (chrome-remote-interface installs its own). Installing `@testivai/witness` no longer pulls in ora and the packages it depends on. No behaviour changes.
