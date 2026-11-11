"""The capture's metadata.json: capture provenance and capture health (docs/extension-api.md)."""

from __future__ import annotations

import json
from typing import Any, Optional


def write_capture_metadata(temp_dir: Any, name: str, *, environment: Optional[dict], health: Optional[dict]) -> None:
    """
    Write `.testivai/temp/<name>/metadata.json` with what this capture
    observed. Written whole for each capture, never merged: a `health` block
    from an earlier run must not outlive a run that could not check. A part
    that is None is left out (no `health` reads as "not checked"). Best-effort:
    the screenshot never depends on it.
    """
    data: dict = {"name": name}
    if environment:
        data["environment"] = environment
    if health:
        data["health"] = health
    try:
        (temp_dir / "metadata.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError:
        pass
