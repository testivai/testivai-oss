"""
The in-page probes a capture records with its metadata.json.

`health_probe.js` and `render_probe.js` are GENERATED from
packages/witness/src/capture/health.ts (HEALTH_PROBE_EXPRESSION) and
environment.ts (RENDER_PROBE_EXPRESSION) by
scripts/generate-element-map-asset.js, and CI fails if they are stale: every
adapter, in every language, evaluates the same text.
"""

from __future__ import annotations

from importlib import resources
from typing import Any, Callable, Optional

_START = "(function () {"


class Probe:
    """One generated probe: a self-contained expression evaluated in the page."""

    def __init__(self, filename: str) -> None:
        self.filename = filename
        self._expression: Optional[str] = None

    def expression(self) -> str:
        """The expression, without the generated file's banner (cached)."""
        if self._expression is None:
            raw = resources.files("testivai").joinpath(self.filename).read_text(encoding="utf-8")
            start = raw.find(_START)
            if start == -1:
                raise RuntimeError(
                    f"{self.filename} is malformed. Regenerate with scripts/generate-element-map-asset.js"
                )
            self._expression = raw[start:].strip()
        return self._expression

    def for_webdriver(self) -> str:
        """WebDriver's execute_script runs a function body: return the expression's value."""
        return f"return {self.expression()};"


HEALTH_PROBE = Probe("health_probe.js")
RENDER_PROBE = Probe("render_probe.js")


def run_probe(evaluate: Callable[[str], Any], probe: Probe, *, webdriver: bool) -> Any:
    """
    Evaluate a probe with the driver's evaluate function (Playwright's
    page.evaluate, or Selenium's execute_script with `webdriver=True`).
    Best-effort: a page that refuses it gives None, never an exception.
    """
    try:
        return evaluate(probe.for_webdriver() if webdriver else probe.expression())
    except Exception:
        return None
