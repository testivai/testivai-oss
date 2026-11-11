"""
Capture implementation for playwright-python (sync API).

Semantics mirror the JS adapters exactly (@testivai/witness-playwright):
  1. stabilization CSS: animations/transitions complete instantly at their
     FINAL state, caret hidden, smooth scroll off; wait for web fonts
  2. ignoreSelectors: hidden from pixels (visibility:hidden) AND excluded
     from the DOM snapshot (one consistent semantic)
  3. variant keying: `<name>__<variant>` so parallel browsers/viewports
     never overwrite each other's baselines
  4. on-disk contract: .testivai/temp/<name>/{screenshot.png, dom.html,
     metadata.json}: metadata.json holds capture provenance (`environment`)
     and capture health (`health`, what failed to load), as the JS adapters
     record them

The compare/report half stays in @testivai/witness — run `testivai report`
(see runner.run_report), which playwright-python users can always do because
Playwright for Python ships with a Node.js driver.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any, Optional, Sequence

from ._environment import CAPTURE_METHODS, playwright_environment
from ._health import probe_health
from ._metadata import write_capture_metadata
from ._probes import RENDER_PROBE, run_probe

#: Mirrors STABILIZE_CSS in @testivai/witness-playwright (config/stabilize.ts).
#: Near-zero durations (not `none`) let entry animations COMPLETE at their
#: final state — pages whose content starts hidden render fully.
STABILIZE_CSS = (
    "*, *::before, *::after {"
    " animation-duration: 0.001s !important;"
    " animation-delay: 0s !important;"
    " animation-iteration-count: 1 !important;"
    " transition-duration: 0.001s !important;"
    " transition-delay: 0s !important;"
    " caret-color: transparent !important;"
    " scroll-behavior: auto !important;"
    " }"
)

_FONTS_READY_JS = "document.fonts ? document.fonts.status !== 'loading' : true"

_DOM_SNAPSHOT_JS = """
(selectors) => {
  const clone = document.documentElement.cloneNode(true);
  for (const sel of selectors) {
    try { clone.querySelectorAll(sel).forEach(el => el.remove()); } catch (e) {}
  }
  return clone.outerHTML;
}
"""


def sanitize_variant(variant: str) -> str:
    """Match the JS adapters: non [a-z0-9_-] runs become '_', lowercased."""
    return re.sub(r"[^a-z0-9_-]+", "_", variant, flags=re.IGNORECASE).lower()


def load_local_config(project_root: Path) -> dict:
    """Read .testivai/config.json; defaults mirror @testivai/witness."""
    defaults: dict[str, Any] = {
        "mode": "local",
        "threshold": 0.1,
        "autoOpen": True,
        "failOnDiff": False,
        "stabilize": True,
        "ignoreSelectors": [],
    }
    config_path = project_root / ".testivai" / "config.json"
    if not config_path.exists():
        return defaults
    try:
        loaded = json.loads(config_path.read_text())
        return {**defaults, **loaded}
    except (OSError, json.JSONDecodeError):
        return defaults


def build_ignore_css(selectors: Sequence[str]) -> str:
    """visibility:hidden preserves layout — same rule as the JS adapters."""
    return "\n".join(f"{sel} {{ visibility: hidden !important; }}" for sel in selectors)


@dataclass(frozen=True)
class CapturePlan:
    """What one witness() call captures, resolved from its arguments and config.json."""

    name: str
    temp_dir: Path
    stabilize: bool
    selectors: list
    variant: Optional[str]

    @property
    def css(self) -> str:
        """The one style tag a capture injects: stabilization, then the ignores."""
        parts = []
        if self.stabilize:
            parts.append(STABILIZE_CSS)
        if self.selectors:
            parts.append(build_ignore_css(self.selectors))
        return "\n".join(parts)


def plan_capture(
    caller: str,
    name: Any,
    ignore_selectors: Optional[Sequence[str]],
    stabilize: Optional[bool],
    variant: Optional[str],
    project_root: Optional[Path],
) -> CapturePlan:
    """
    Validate the name and resolve what to capture, the same way for every
    Python adapter: per-call ignore selectors after config.json's (each kept
    once, in first-seen order), the per-call stabilize over config's, and the
    variant folded into the name as `<name>__<variant>`.
    """
    if not name or not isinstance(name, str):
        raise ValueError(f"{caller}: snapshot name is required and must be a non-empty string")

    root = Path(project_root) if project_root else Path.cwd()
    config = load_local_config(root)
    selectors = list(dict.fromkeys([*config.get("ignoreSelectors", []), *(ignore_selectors or [])]))
    if variant:
        name = f"{name}__{sanitize_variant(variant)}"
    return CapturePlan(
        name=name,
        temp_dir=root / ".testivai" / "temp" / name,
        stabilize=config["stabilize"] if stabilize is None else stabilize,
        selectors=selectors,
        variant=variant,
    )


def witness(
    page: Any,
    name: str,
    *,
    ignore_selectors: Optional[Sequence[str]] = None,
    stabilize: Optional[bool] = None,
    variant: Optional[str] = None,
    skip_dom: bool = False,
    project_root: Optional[Path] = None,
) -> Path:
    """
    Capture a visual snapshot from a playwright-python (sync API) Page.

    Writes `.testivai/temp/<name>/screenshot.png` (+ `dom.html`), then
    `testivai report` (or the pytest plugin's session hook) compares against
    committed baselines.

    Args:
        page: playwright.sync_api.Page (duck-typed: screenshot / evaluate /
            add_style_tag are all that's required).
        name: Snapshot name; becomes the directory under .testivai/temp/.
        ignore_selectors: Per-call CSS selectors hidden from pixels and
            excluded from the DOM snapshot. Merged with the global
            `ignoreSelectors` from .testivai/config.json.
        stabilize: Override the stabilization default (config `stabilize`,
            default True).
        variant: Multi-browser/viewport key, folded into the name as
            `<name>__<variant>` so parallel runs never collide.
        skip_dom: Skip the DOM snapshot (disables the noise hint for this
            snapshot; pixel diff still works).
        project_root: Defaults to the current working directory.

    Returns:
        The temp directory the capture was written to.
    """
    plan = plan_capture("testivai.witness", name, ignore_selectors, stabilize, variant, project_root)
    # What the page is rendered with, read before anything is injected.
    render = run_probe(page.evaluate, RENDER_PROBE, webdriver=False)
    health = _shoot(page, plan)
    if not skip_dom:
        _write_dom(page, plan)
    write_capture_metadata(plan.temp_dir, plan.name, environment=_environment(page, plan, render), health=health)
    return plan.temp_dir


def _shoot(page: Any, plan: CapturePlan) -> Optional[dict]:
    """Prepare the page, take the full-page screenshot, read its health, put the page back."""
    style_handle = _add_style(page, plan)
    plan.temp_dir.mkdir(parents=True, exist_ok=True)
    try:
        # Full-page screenshot via Playwright's native API
        page.screenshot(path=str(plan.temp_dir / "screenshot.png"), full_page=True)
        # Capture health right after the screenshot, before the styles come
        # off: removing one that hid an element can start loading a web font
        # that was never in the image.
        return probe_health(page.evaluate, webdriver=False)
    finally:
        _remove_style(style_handle)


def _browser_of(page: Any) -> tuple:
    """Playwright's own name and version for the browser, or (None, None): a persistent context has no Browser."""
    try:
        browser = page.context.browser
        return (browser.browser_type.name, browser.version) if browser is not None else (None, None)
    except Exception:
        return None, None


def _environment(page: Any, plan: CapturePlan, render: Any) -> Optional[dict]:
    """Capture provenance for this capture. Best-effort, like the rest of the metadata."""
    name, version = _browser_of(page)
    try:
        return playwright_environment(name, version, render, CAPTURE_METHODS["PLAYWRIGHT_FULL_PAGE"], plan.variant)
    except Exception:
        return None


def _add_style(page: Any, plan: CapturePlan) -> Any:
    """One style tag covering stabilization + ignores; then wait for web fonts."""
    css = plan.css
    if not css:
        return None
    try:
        handle = page.add_style_tag(content=css)
    except Exception:
        handle = None  # locked-down page; capture proceeds
    if plan.stabilize:
        _wait_for_fonts(page)
    return handle


def _remove_style(handle: Any) -> None:
    if handle is None:
        return
    try:
        handle.evaluate("el => el.remove()")
    except Exception:
        pass  # best-effort cleanup


def _write_dom(page: Any, plan: CapturePlan) -> None:
    """
    DOM snapshot with ignored elements removed (best-effort — a flaky page
    never breaks the screenshot path; missing dom.html just suppresses the
    noise hint).
    """
    try:
        dom = page.evaluate(_DOM_SNAPSHOT_JS, list(plan.selectors))
        if isinstance(dom, str) and dom:
            (plan.temp_dir / "dom.html").write_text(dom, encoding="utf-8")
    except Exception:
        pass


def _wait_for_fonts(page: Any, timeout_seconds: float = 10.0) -> None:
    """Bounded wait for web fonts — a fallback-font capture diffs 30%+."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            if page.evaluate(_FONTS_READY_JS):
                return
        except Exception:
            return
        time.sleep(0.1)


# ── Element-map collector ──────────────────────────────────────────────────
#
# `element_map.js` is GENERATED from packages/witness/src/capture/element-map.ts
# by scripts/generate-element-map-asset.js, and CI fails if it is stale. Every
# adapter -- TypeScript, Python, Java -- injects that identical function, which
# matters because all of them write into one shared `.testivai/baselines/`
# directory: two languages producing subtly different maps for the same page
# would surface as phantom regressions.

_DEFAULT_MAX_ELEMENTS = 3000

_ELEMENT_MAP_SRC: Optional[str] = None


def _load_element_map_source() -> str:
    """
    Read the generated collector, cached after the first call.

    The file starts with a "do not edit" banner comment that is useful to a
    reader but pure weight on the wire, so it is sliced off: every capture
    ships this string to the browser.
    """
    global _ELEMENT_MAP_SRC
    if _ELEMENT_MAP_SRC is None:
        raw = resources.files("testivai").joinpath("element_map.js").read_text(
            encoding="utf-8"
        )
        start = raw.find("function collectElementMap")
        if start == -1:
            raise RuntimeError(
                "element_map.js is malformed: collectElementMap not found. "
                "Regenerate with scripts/generate-element-map-asset.js"
            )
        _ELEMENT_MAP_SRC = raw[start:].strip()
    return _ELEMENT_MAP_SRC


def _element_map_expression(max_elements: int, ignore_selectors: Sequence[str]) -> str:
    """
    Wrap the collector exactly as `buildElementMapExpression` does on the
    TypeScript side. Selenium/WebDriver needs the explicit `return`.
    """
    return "return ({0})(document, window, {1}, {2});".format(
        _load_element_map_source(),
        int(max_elements),
        json.dumps(list(ignore_selectors)),
    )


# ── Page-settled probe ──────────────────────────────────────────────────────
#
# `settle.js` is GENERATED from packages/witness/src/capture/settle.ts, same as
# element_map.js, so every language polls the identical predicate.
#
# Deliberately NOT network idle: Playwright's own docs mark that DISCOURAGED for
# testing, and it is the wrong signal for a visual snapshot — a page with
# analytics beacons never goes quiet, while a network-idle page can still be
# animating. What matters is whether the rendered page stopped changing.

DEFAULT_QUIET_MS = 150
DEFAULT_SETTLE_TIMEOUT = 5.0

_SETTLE_SRC: Optional[str] = None


def _load_settle_source() -> str:
    global _SETTLE_SRC
    if _SETTLE_SRC is None:
        raw = resources.files("testivai").joinpath("settle.js").read_text(encoding="utf-8")
        start = raw.find("function settleProbe")
        if start == -1:
            raise RuntimeError(
                "settle.js is malformed: settleProbe not found. "
                "Regenerate with scripts/generate-element-map-asset.js"
            )
        _SETTLE_SRC = raw[start:].strip()
    return _SETTLE_SRC


def _settle_expression(quiet_ms: int) -> str:
    return "return ({0})(document, window, {1});".format(_load_settle_source(), int(quiet_ms))


def wait_for_settled(driver: Any, quiet_ms: int = DEFAULT_QUIET_MS,
                     timeout: float = DEFAULT_SETTLE_TIMEOUT) -> None:
    """
    Poll until the page stops changing, or give up.

    Always bounded: a page that never settles yields a capture, not a hang. A
    driver that cannot evaluate the probe returns something unusable, in which
    case we proceed at once rather than paying the whole timeout every capture.
    """
    expr = _settle_expression(quiet_ms)
    deadline = time.time() + timeout
    while True:
        try:
            state = driver.execute_script(expr)
        except Exception:
            return
        if not isinstance(state, dict) or not isinstance(state.get("settled"), bool):
            return
        if state["settled"] or time.time() >= deadline:
            return
        time.sleep(0.05)


def stop_settle_observer(driver: Any) -> None:
    """Detach the observer so it does not linger on the page under test."""
    try:
        driver.execute_script(
            "try { var s = window.__testivaiSettleState;"
            " if (s && s.observer && s.observer.disconnect) s.observer.disconnect(); } catch (e) {}"
            " try { delete window.__testivaiSettleState; } catch (e) {}"
        )
    except Exception:
        pass
