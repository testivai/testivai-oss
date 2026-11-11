"""
TestivAI for Python — local-first visual regression capture for
playwright-python and Selenium, sharing baselines, reports, tolerances, and PR approvals
with the JS/TS adapters through one on-disk contract.

    from testivai import witness                    # playwright-python
    from testivai.selenium import witness as swit    # Selenium WebDriver

    def test_homepage(page):
        page.goto("http://localhost:3000")
        witness(page, "homepage")

Then `testivai report` (run automatically by the pytest plugin) compares
against `.testivai/baselines/` and writes `visual-report/index.html`.
"""

from ._capture import (
    STABILIZE_CSS,
    build_ignore_css,
    load_local_config,
    sanitize_variant,
    witness,
)
from ._version import __version__
from .runner import resolve_cli, run_report
from .selenium import witness as witness_selenium

__all__ = [
    "witness",
    "witness_selenium",
    "run_report",
    "resolve_cli",
    "load_local_config",
    "build_ignore_css",
    "sanitize_variant",
    "STABILIZE_CSS",
    "__version__",
]

