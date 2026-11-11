"""
Capture implementation for Selenium WebDriver (Python bindings).

Same semantics as the playwright-python adapter (`testivai.witness`) and the
JS/TS adapters — one on-disk contract, one report, one approval flow:
  1. stabilization CSS: animations/transitions complete instantly at their
     FINAL state, caret hidden, smooth scroll off; wait for web fonts
  2. ignoreSelectors: hidden from pixels (visibility:hidden) AND excluded
     from the DOM snapshot (one consistent semantic)
  3. variant keying: `<name>__<variant>` so parallel browsers/viewports
     never overwrite each other's baselines
  4. on-disk contract: .testivai/temp/<name>/{screenshot.png, dom.html,
     elements.json, metadata.json}: metadata.json holds capture provenance
     (`environment`, with the capture method that took the screenshot) and
     capture health (`health`, what failed to load), as the JS adapters
     record them

Full-page screenshots per browser:
  - Chromium (Chrome/Edge): CDP `Page.captureScreenshot` with
    captureBeyondViewport — same mechanism Playwright uses
  - Firefox: the bindings' native `get_full_page_screenshot_as_png()`
  - anything else: viewport screenshot (documented fallback)

    from testivai.selenium import witness

    def test_homepage(driver):
        driver.get("http://localhost:3000")
        witness(driver, "homepage")

The compare/report half stays in @testivai/witness — run `testivai report`
(the pytest plugin's session hook does it automatically).
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path
from typing import Any, Optional, Sequence

from ._capture import (
    _DEFAULT_MAX_ELEMENTS,
    CapturePlan,
    _element_map_expression,
    plan_capture,
    stop_settle_observer,
    wait_for_settled,
)
from ._environment import CAPTURE_METHODS, adapter_block, python_framework, webdriver_environment
from ._health import probe_health
from ._metadata import write_capture_metadata
from ._probes import RENDER_PROBE, run_probe

_STYLE_ID = "__testivai_capture_style__"

_INJECT_STYLE_JS = (
    "var s = document.createElement('style');"
    "s.id = arguments[0]; s.textContent = arguments[1];"
    "document.head.appendChild(s);"
)

_REMOVE_STYLE_JS = (
    "var s = document.getElementById(arguments[0]); if (s) s.remove();"
)

_FONTS_READY_JS = "return document.fonts ? document.fonts.status !== 'loading' : true;"

# Selenium's execute_script passes args via `arguments`, not a function param.
_DOM_SNAPSHOT_JS = """
var selectors = arguments[0] || [];
var clone = document.documentElement.cloneNode(true);
for (var i = 0; i < selectors.length; i++) {
  try {
    clone.querySelectorAll(selectors[i]).forEach(function (el) { el.remove(); });
  } catch (e) {}
}
return clone.outerHTML;
"""

_CHROMIUM_NAMES = {"chrome", "chromium", "msedge", "microsoftedge", "edge"}


def witness(
    driver: Any,
    name: str,
    *,
    ignore_selectors: Optional[Sequence[str]] = None,
    stabilize: Optional[bool] = None,
    variant: Optional[str] = None,
    skip_dom: bool = False,
    skip_element_map: bool = False,
    max_elements: Optional[int] = None,
    project_root: Optional[Path] = None,
) -> Path:
    """
    Capture a visual snapshot from a Selenium WebDriver.

    Writes `.testivai/temp/<name>/screenshot.png` (+ `dom.html`), then
    `testivai report` (or the pytest plugin's session hook) compares against
    committed baselines.

    Args:
        driver: selenium.webdriver.* instance (duck-typed: execute_script
            plus a screenshot method are all that's required).
        name: Snapshot name; becomes the directory under .testivai/temp/.
        ignore_selectors: Per-call CSS selectors hidden from pixels and
            excluded from the DOM snapshot. Merged with the global
            `ignoreSelectors` from .testivai/config.json.
        stabilize: Override the stabilization default (config `stabilize`,
            default True).
        variant: Multi-browser/viewport key, folded into the name as
            `<name>__<variant>` so parallel runs never collide.
        skip_element_map: Skip the element map. The map powers
            region->selector attribution, shift classification and the
            computed-style fingerprint; without it the report falls back to
            the pixel and DOM layers.
        max_elements: Cap on elements walked for the map (default 3000).
        skip_dom: Skip the DOM snapshot (disables the noise hint for this
            snapshot; pixel diff still works).
        project_root: Defaults to the current working directory.

    Returns:
        The temp directory the capture was written to.
    """
    plan = plan_capture("testivai.selenium.witness", name, ignore_selectors, stabilize, variant, project_root)
    # What the page is rendered with, read before anything is injected.
    render = run_probe(driver.execute_script, RENDER_PROBE, webdriver=True)
    capture_method, health = _shoot(driver, plan)
    _write_page_data(driver, plan, skip_dom, skip_element_map, max_elements)
    environment = _environment(driver, plan, render, capture_method)
    write_capture_metadata(plan.temp_dir, plan.name, environment=environment, health=health)
    return plan.temp_dir


def _shoot(driver: Any, plan: CapturePlan) -> tuple:
    """Prepare the page, take the screenshot, read its health, put the page back."""
    style_injected = _inject_style(driver, plan)
    plan.temp_dir.mkdir(parents=True, exist_ok=True)
    try:
        # Full-page screenshot, best mechanism the browser offers
        png, capture_method = _capture_screenshot(driver)
        (plan.temp_dir / "screenshot.png").write_bytes(png)
        # Capture health right after the screenshot, before the styles come
        # off: removing one that hid an element can start loading a web font
        # that was never in the image.
        return capture_method, probe_health(driver.execute_script, webdriver=True)
    finally:
        _restore_page(driver, plan, style_injected)


def _environment(driver: Any, plan: CapturePlan, render: Any, capture_method: str) -> Optional[dict]:
    """
    Capture provenance: the browser and driver from the session's
    capabilities (the user agent when they say nothing), the render settings
    from the probe. Best-effort, like the rest of the metadata.
    """
    try:
        capabilities = getattr(driver, "capabilities", None)
    except Exception:
        capabilities = None  # the session is gone: the user agent is the fallback
    try:
        return webdriver_environment(capabilities, render, adapter_block(capture_method),
                                     python_framework("selenium"), project=plan.variant)
    except Exception:
        return None


def _inject_style(driver: Any, plan: CapturePlan) -> bool:
    """One style tag covering stabilization + ignores; then wait for the page."""
    css = plan.css
    if not css:
        return False
    try:
        driver.execute_script(_INJECT_STYLE_JS, _STYLE_ID, css)
        injected = True
    except Exception:
        injected = False  # locked-down page; capture proceeds
    if plan.stabilize:
        _wait_for_fonts(driver)
        # Then wait for the page itself to stop changing — images finished,
        # DOM quiet. This is the load question the DOM/style layer cannot
        # answer: content that never arrived reads as a real change.
        wait_for_settled(driver)
    return injected


def _restore_page(driver: Any, plan: CapturePlan, style_injected: bool) -> None:
    if style_injected:
        try:
            driver.execute_script(_REMOVE_STYLE_JS, _STYLE_ID)
        except Exception:
            pass  # best-effort cleanup
    if plan.stabilize:
        # Detach the observer so it does not linger on the page under test.
        stop_settle_observer(driver)


def _write_page_data(
    driver: Any, plan: CapturePlan, skip_dom: bool, skip_element_map: bool, max_elements: Optional[int]
) -> None:
    if not skip_dom:
        _write_dom(driver, plan)
    if not skip_element_map:
        _write_element_map(driver, plan, max_elements)


def _write_dom(driver: Any, plan: CapturePlan) -> None:
    """
    DOM snapshot with ignored elements removed (best-effort — a flaky page
    never breaks the screenshot path; missing dom.html just suppresses the
    noise hint).
    """
    try:
        dom = driver.execute_script(_DOM_SNAPSHOT_JS, list(plan.selectors))
        if isinstance(dom, str) and dom:
            (plan.temp_dir / "dom.html").write_text(dom, encoding="utf-8")
    except Exception:
        pass


def _write_element_map(driver: Any, plan: CapturePlan, max_elements: Optional[int]) -> None:
    """
    Element map (best-effort, same contract as the DOM snapshot). Powers
    region->selector attribution, shift classification and the style
    fingerprint. The injected collector is the SAME function every other
    adapter injects -- see element_map.js, which is generated from the
    TypeScript source so the languages cannot drift apart.
    """
    try:
        expr = _element_map_expression(
            max_elements if max_elements is not None else _DEFAULT_MAX_ELEMENTS,
            list(plan.selectors),
        )
        element_map = driver.execute_script(expr)
        if isinstance(element_map, list) and element_map:
            (plan.temp_dir / "elements.json").write_text(json.dumps(element_map), encoding="utf-8")
    except Exception:
        pass


def _browser_name(driver: Any) -> str:
    try:
        caps = getattr(driver, "capabilities", None) or {}
        return str(caps.get("browserName", "")).lower()
    except Exception:
        return ""


def _capture_screenshot(driver: Any) -> tuple:
    """Full-page where the browser supports it, viewport otherwise; and how it was taken."""
    browser = _browser_name(driver)

    # Chromium: CDP captureBeyondViewport — the same full-page mechanism
    # Playwright uses under the hood.
    if browser in _CHROMIUM_NAMES and hasattr(driver, "execute_cdp_cmd"):
        try:
            result = driver.execute_cdp_cmd(
                "Page.captureScreenshot",
                {"captureBeyondViewport": True, "format": "png"},
            )
            data = (result or {}).get("data")
            if data:
                return base64.b64decode(data), CAPTURE_METHODS["CDP_FULL_PAGE"]
        except Exception:
            pass  # fall through to the viewport screenshot

    # Firefox exposes full-page natively in the Python bindings.
    if hasattr(driver, "get_full_page_screenshot_as_png"):
        try:
            return driver.get_full_page_screenshot_as_png(), CAPTURE_METHODS["FIREFOX_FULL_PAGE"]
        except Exception:
            pass

    # Fallback: viewport-only (Safari and friends).
    return driver.get_screenshot_as_png(), CAPTURE_METHODS["WEBDRIVER_VIEWPORT"]


def _wait_for_fonts(driver: Any, timeout_seconds: float = 10.0) -> None:
    """Bounded wait for web fonts — a fallback-font capture diffs 30%+."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            if driver.execute_script(_FONTS_READY_JS):
                return
        except Exception:
            return
        time.sleep(0.1)
