"""
Capture health for the Python adapters: the probe asset and the validator.

The probe is HEALTH_PROBE_EXPRESSION from packages/witness/src/capture/health.ts,
shipped as the generated health_probe.js; parse_health is the Python port of
parseHealth (its cases below are the JS suite's). Whether the two agree on the
same input is checked in test_parity_with_js.py; whether the probe finds a
stylesheet that answered 404 in a real browser, in test_browser_capture.py.
"""

import copy

import pytest

from testivai._health import HEALTH_LIMITS, parse_health
from testivai._probes import HEALTH_PROBE, RENDER_PROBE

HEALTHY = {
    "fonts": {"status": "loaded", "failed": []},
    "stylesheets": {"failed": 0, "urls": []},
    "images": {"broken": 0, "urls": []},
    "resources": {"status": "checked", "failed": {}},
}

BROKEN_STYLESHEET = {
    "fonts": {"status": "loaded", "failed": []},
    "stylesheets": {"failed": 1, "urls": ["127.0.0.1:8000/missing.css"]},
    "images": {"broken": 0, "urls": []},
    "resources": {
        "status": "checked",
        "failed": {"css": {"count": 1, "entries": [{"url": "127.0.0.1:8000/missing.css", "status": 404}]}},
    },
}


def with_(base, **parts):
    out = copy.deepcopy(base)
    for key, value in parts.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = value
    return out


class TestProbeAssets:
    @pytest.mark.parametrize("probe", [HEALTH_PROBE, RENDER_PROBE], ids=["health", "render"])
    def test_one_self_contained_expression_without_the_banner(self, probe):
        expr = probe.expression()
        assert expr.startswith("(function () {")
        assert expr.endswith("})()")
        assert "AUTO-GENERATED" not in expr

    def test_the_health_probe_is_the_generated_copy_of_HEALTH_PROBE_EXPRESSION(self):
        expr = HEALTH_PROBE.expression()
        # HEALTH_LIMITS filled in by the generator, and what the JS adapters read
        assert f"var LIMIT = {HEALTH_LIMITS['list']};" in expr
        assert f"var MAX = {HEALTH_LIMITS['url']};" in expr
        for part in ("document.fonts", "link[rel]", "document.images", "responseStatus"):
            assert part in expr

    def test_webdriver_form_returns_the_expression(self):
        assert HEALTH_PROBE.for_webdriver() == f"return {HEALTH_PROBE.expression()};"


class TestParseHealth:
    def test_a_healthy_block_passes_through(self):
        assert parse_health(HEALTHY) == HEALTHY

    def test_a_failed_stylesheet_is_kept(self):
        assert parse_health(BROKEN_STYLESHEET) == BROKEN_STYLESHEET

    def test_returns_a_normalized_copy_with_unknown_fields_dropped(self):
        raw = with_(HEALTHY, extra=1, fonts={"status": "loaded", "failed": [], "more": True})
        assert parse_health(raw) == HEALTHY

    def test_an_error_text_on_a_resource_entry_is_kept(self):
        entry = {"url": "cdn.example.com/a.css", "status": 0, "error": "net::ERR_FAILED"}
        raw = with_(HEALTHY, resources={"status": "checked", "failed": {"css": {"count": 1, "entries": [entry]}}})
        assert parse_health(raw)["resources"]["failed"]["css"]["entries"] == [entry]

    @pytest.mark.parametrize(
        "raw",
        [
            None,
            [],
            "healthy",
            with_(HEALTHY, fonts=None),
            with_(HEALTHY, fonts={"status": "ok", "failed": []}),
            with_(HEALTHY, fonts={"status": "loaded", "failed": [{"weight": "400", "style": "normal"}]}),
            with_(HEALTHY, stylesheets={"failed": -1, "urls": []}),
            with_(HEALTHY, images={"broken": 1.5, "urls": []}),
            with_(HEALTHY, images={"broken": True, "urls": []}),
            with_(HEALTHY, images={"broken": 1, "urls": [42]}),
            with_(HEALTHY, images={"broken": 1, "urls": ["x" * (HEALTH_LIMITS["url"] + 1)]}),
            with_(HEALTHY, resources={"status": "maybe", "failed": {}}),
            with_(HEALTHY, resources={"status": "checked", "failed": {"video": {"count": 1, "entries": []}}}),
            with_(HEALTHY, resources={"status": "checked", "failed": {"css": {"count": 1, "entries": [{"url": "a.css"}]}}}),
        ],
        ids=[
            "nothing", "a list", "text", "no fonts", "an unknown font status", "a face without a family",
            "a negative count", "a fractional count", "a boolean count", "a url that is not text",
            "an over-long url", "an unknown resource status", "an unknown resource type",
            "a resource entry without a status",
        ],
    )
    def test_rejects_malformed_input_as_not_checked_never_a_throw(self, raw):
        assert parse_health(raw) is None

    def test_caps_long_lists_instead_of_rejecting_them(self):
        urls = [f"example.com/{i}.png" for i in range(25)]
        parsed = parse_health(with_(HEALTHY, images={"broken": 25, "urls": urls}))
        assert parsed["images"] == {"broken": 25, "urls": urls[: HEALTH_LIMITS["list"]]}
