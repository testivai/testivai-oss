"""
Capture health: what failed to load when the page was captured.

A web font that failed and fell back, or a stylesheet that answered 404, can
leave the DOM identical and the computed styles matching, so the diff looks
like render noise. The JS adapters record the probe's result as `health` in
the capture's metadata.json; the compare then calls such a capture unhealthy.
This module validates the probe's result the way `parseHealth`
(packages/witness/src/capture/health.ts) does: anything malformed is None,
which reads as "not checked", never as healthy.

Numbers and lengths are judged as JavaScript judges them (an integer-valued
float is an integer, a boolean is not; text length counts UTF-16 code units),
so a block the JS side would accept is accepted here and the other way round.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from ._probes import HEALTH_PROBE, run_probe

#: The caps HEALTH_PROBE_EXPRESSION applies (packages/witness/src/capture/health-limits.ts).
HEALTH_LIMITS = {"list": 10, "url": 200, "text": 200}
RESOURCE_TYPES = ("css", "font", "img", "script", "other")
_FONT_STATUSES = ("loaded", "loading", "unavailable")
_RESOURCE_STATUSES = ("checked", "unavailable")


class _Malformed(Exception):
    pass


def _record(value: Any) -> dict:
    if not isinstance(value, dict):
        raise _Malformed()
    return value


def _count(value: Any) -> int:
    """A non-negative integer, as Number.isInteger sees it (2.0 is one, True is not)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _Malformed()
    if isinstance(value, float) and not value.is_integer():
        raise _Malformed()
    if value < 0:
        raise _Malformed()
    return int(value)


def _utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _text(value: Any, limit: int) -> str:
    if not isinstance(value, str) or _utf16_length(value) > limit:
        raise _Malformed()
    return value


def _one_of(value: Any, allowed: tuple) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise _Malformed()
    return value


def _list(value: Any, item: Callable[[Any], Any]) -> list:
    """A list, capped at HEALTH_LIMITS['list'] (longer lists are cut, not rejected)."""
    if not isinstance(value, list):
        raise _Malformed()
    return [item(x) for x in value[: HEALTH_LIMITS["list"]]]


def _url(value: Any) -> str:
    return _text(value, HEALTH_LIMITS["url"])


def _face(value: Any) -> dict:
    face = _record(value)
    limit = HEALTH_LIMITS["text"]
    return {"family": _text(face.get("family"), limit), "weight": _text(face.get("weight"), limit),
            "style": _text(face.get("style"), limit)}


def _entry(value: Any) -> dict:
    entry = _record(value)
    out = {"url": _url(entry.get("url")), "status": _count(entry.get("status"))}
    if "error" in entry:
        out["error"] = _text(entry["error"], HEALTH_LIMITS["text"])
    return out


def _failures(value: Any) -> dict:
    group = _record(value)
    return {"count": _count(group.get("count")), "entries": _list(group.get("entries"), _entry)}


def _read_block(raw: Any) -> dict:
    block = _record(raw)
    fonts = _record(block.get("fonts"))
    stylesheets = _record(block.get("stylesheets"))
    images = _record(block.get("images"))
    resources = _record(block.get("resources"))
    failed = {_one_of(kind, RESOURCE_TYPES): _failures(group) for kind, group in _record(resources.get("failed")).items()}
    return {
        "fonts": {"status": _one_of(fonts.get("status"), _FONT_STATUSES), "failed": _list(fonts.get("failed"), _face)},
        "stylesheets": {"failed": _count(stylesheets.get("failed")), "urls": _list(stylesheets.get("urls"), _url)},
        "images": {"broken": _count(images.get("broken")), "urls": _list(images.get("urls"), _url)},
        "resources": {"status": _one_of(resources.get("status"), _RESOURCE_STATUSES), "failed": failed},
    }


def parse_health(raw: Any) -> Optional[dict]:
    """
    Validate a health block: a normalized copy (unknown fields dropped, lists
    capped), or None for anything malformed. Never raises.
    """
    try:
        return _read_block(raw)
    except _Malformed:
        return None


def probe_health(evaluate: Callable[[str], Any], *, webdriver: bool) -> Optional[dict]:
    """
    Run the probe in the page and validate its result. Read it right after the
    screenshot, before the capture's injected styles come off: removing a style
    that hid an element can start loading a web font that was never in the image.
    """
    return parse_health(run_probe(evaluate, HEALTH_PROBE, webdriver=webdriver))
