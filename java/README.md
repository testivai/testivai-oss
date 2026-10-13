# TestivAI for Java (experimental)

Local-first visual regression capture for playwright-java and Selenium
(Java). Same stabilization, ignore and naming rules and on-disk contract as
every TestivAI adapter — one set of baselines, one report, one approval flow
across languages. One difference: playwright-java records no element map
yet, so its identical-DOM diffs read *styles not compared* rather than likely
noise (see [Capture semantics](../docs/frameworks/java.md#capture-semantics)).

Status: full source, compiled + unit-tested in CI (9 JUnit tests), not yet published to Maven Central.
Build with `mvn package`. Docs: [docs/frameworks/java.md](../docs/frameworks/java.md).
