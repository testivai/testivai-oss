"""
Unit tests for the Selenium capture adapter. The WebDriver is duck-typed,
so fakes exercise the full capture flow without a browser — same approach
as the playwright adapter's tests.
"""

import base64
import json
from pathlib import Path

import pytest

from testivai.selenium import _STYLE_ID, witness


PNG = b"\x89PNG\r\n\x1a\nfakepixels"
PNG_B64 = base64.b64encode(PNG).decode()


class FakeChromeDriver:
    """Duck-typed Chrome: CDP full-page + execute_script surface."""

    capabilities = {"browserName": "chrome"}

    def __init__(self, dom="<html><head></head><body><p>Hi</p></body></html>", fail_cdp=False):
        self.dom = dom
        self.fail_cdp = fail_cdp
        self.scripts: list[tuple] = []
        self.injected_css: list[str] = []
        self.style_removed = False
        self.viewport_screenshots = 0

    def execute_script(self, script, *args):
        self.scripts.append((script, args))
        if "createElement('style')" in script:
            self.injected_css.append(args[1])
            return None
        if "getElementById" in script and "remove" in script:
            self.style_removed = True
            return None
        if "document.fonts" in script:
            return True
        if "collectElementMap" in script:
            return _run_collector_in_node(script)
        if "cloneNode" in script:
            dom = self.dom
            for sel in args[0] or []:
                dom = dom.replace(f'<div class="{sel.lstrip(".")}">SECRET</div>', "")
            return dom
        return None

    def execute_cdp_cmd(self, cmd, params):
        assert cmd == "Page.captureScreenshot"
        assert params["captureBeyondViewport"] is True
        if self.fail_cdp:
            raise RuntimeError("cdp boom")
        return {"data": PNG_B64}

    def get_screenshot_as_png(self):
        self.viewport_screenshots += 1
        return PNG


class FakeFirefoxDriver(FakeChromeDriver):
    capabilities = {"browserName": "firefox"}

    def __init__(self, **kw):
        super().__init__(**kw)
        self.full_page_calls = 0

    execute_cdp_cmd = None  # firefox bindings have no CDP helper

    def get_full_page_screenshot_as_png(self):
        self.full_page_calls += 1
        return PNG


class FakeSafariDriver(FakeChromeDriver):
    capabilities = {"browserName": "safari"}
    execute_cdp_cmd = None


@pytest.fixture()
def project(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def write_config(root: Path, **overrides):
    cfg = {"mode": "local", **overrides}
    (root / ".testivai").mkdir(parents=True, exist_ok=True)
    (root / ".testivai" / "config.json").write_text(json.dumps(cfg))


def test_chrome_full_page_via_cdp(project):
    driver = FakeChromeDriver()
    temp = witness(driver, "homepage")

    assert temp == project / ".testivai" / "temp" / "homepage"
    assert (temp / "screenshot.png").read_bytes() == PNG
    assert "<p>Hi</p>" in (temp / "dom.html").read_text()
    assert driver.viewport_screenshots == 0  # CDP path, not viewport


def test_chrome_cdp_failure_falls_back_to_viewport(project):
    driver = FakeChromeDriver(fail_cdp=True)
    temp = witness(driver, "x")
    assert (temp / "screenshot.png").read_bytes() == PNG
    assert driver.viewport_screenshots == 1


def test_firefox_uses_native_full_page(project):
    driver = FakeFirefoxDriver()
    witness(driver, "x")
    assert driver.full_page_calls == 1
    assert driver.viewport_screenshots == 0


def test_unknown_browser_viewport_fallback(project):
    driver = FakeSafariDriver()
    witness(driver, "x")
    assert driver.viewport_screenshots == 1


def test_stabilization_css_injected_and_removed(project):
    driver = FakeChromeDriver()
    witness(driver, "x")

    assert any("animation-duration: 0.001s" in css for css in driver.injected_css)
    assert driver.style_removed
    assert any("document.fonts" in script for script, _ in driver.scripts)
    # style element uses the reserved id
    inject_calls = [a for s, a in driver.scripts if "createElement('style')" in s]
    assert inject_calls[0][0] == _STYLE_ID


def test_stabilize_false_via_config(project):
    write_config(project, stabilize=False)
    driver = FakeChromeDriver()
    witness(driver, "x")
    assert driver.injected_css == []


def test_ignore_selectors_merged_and_passed_to_dom_snapshot(project):
    write_config(project, ignoreSelectors=[".from-config"])
    driver = FakeChromeDriver(
        dom='<html><body><div class="badge">SECRET</div><p>Hi</p></body></html>'
    )
    witness(driver, "x", ignore_selectors=[".badge"])

    injected = "\n".join(driver.injected_css)
    assert ".from-config { visibility: hidden !important; }" in injected
    assert ".badge { visibility: hidden !important; }" in injected

    dom_calls = [args for script, args in driver.scripts if "cloneNode" in script]
    assert dom_calls == [([".from-config", ".badge"],)]
    assert "SECRET" not in (project / ".testivai" / "temp" / "x" / "dom.html").read_text()


def test_variant_folds_into_name(project):
    driver = FakeChromeDriver()
    temp = witness(driver, "homepage", variant="Firefox 128 @2x")
    assert temp.name == "homepage__firefox_128_2x"


def test_skip_dom(project):
    driver = FakeChromeDriver()
    temp = witness(driver, "no-dom", skip_dom=True)
    assert (temp / "screenshot.png").exists()
    assert not (temp / "dom.html").exists()


def test_style_removed_even_when_screenshot_fails(project):
    class Exploding(FakeChromeDriver):
        def execute_cdp_cmd(self, cmd, params):
            raise RuntimeError("boom")

        def get_screenshot_as_png(self):
            raise RuntimeError("boom")

    driver = Exploding()
    with pytest.raises(RuntimeError):
        witness(driver, "explodes")
    assert driver.style_removed


def test_empty_name_rejected(project):
    with pytest.raises(ValueError):
        witness(FakeChromeDriver(), "")


def test_top_level_alias():
    from testivai import witness_selenium

    assert witness_selenium is witness


def _run_collector_in_node(script: str):
    """
    Execute the adapter's real injected expression with Node against a
    duck-typed DOM. This is the point of the test: it proves the GENERATED
    asset is runnable JavaScript that returns the shape `elements.json`
    consumers expect -- not merely that execute_script was called.
    """
    import json as _json
    import shutil
    import subprocess
    import textwrap

    node = shutil.which("node")
    if node is None:  # pragma: no cover - CI always has node
        pytest.skip("node not available")

    harness = textwrap.dedent(
        """
        const rect = { x: 0, y: 0, width: 100, height: 40 };
        const mk = (tag) => ({
          tagName: tag.toUpperCase(),
          classList: { length: 0 },
          children: [],
          parentElement: null,
          getBoundingClientRect: () => rect,
          matches: () => false,
        });
        const body = mk('body');
        const p = mk('p');
        p.parentElement = body;
        body.children = [p];
        const document = { body };
        const window = {
          devicePixelRatio: 1, scrollX: 0, scrollY: 0,
          getComputedStyle: () => ({ getPropertyValue: () => 'x' }),
        };
        const out = (function () { %s })();
        process.stdout.write(JSON.stringify(out));
        """
    ) % script

    proc = subprocess.run(
        [node, "-e", harness], capture_output=True, text=True, timeout=30
    )
    assert proc.returncode == 0, f"collector failed to run: {proc.stderr}"
    return _json.loads(proc.stdout)


def test_element_map_written_with_expected_shape(project):
    driver = FakeChromeDriver()
    witness(driver, "with-map")

    path = project / ".testivai" / "temp" / "with-map" / "elements.json"
    assert path.exists(), "elements.json should be written"

    entries = json.loads(path.read_text())
    assert isinstance(entries, list) and entries
    for entry in entries:
        assert isinstance(entry["path"], str)
        assert isinstance(entry["x"], (int, float))
        assert isinstance(entry["y"], (int, float))
        assert isinstance(entry["width"], (int, float))
        assert isinstance(entry["height"], (int, float))
        assert isinstance(entry["styleHash"], str)


def test_skip_element_map(project):
    driver = FakeChromeDriver()
    witness(driver, "no-map", skip_element_map=True)
    assert not (project / ".testivai" / "temp" / "no-map" / "elements.json").exists()


def test_element_map_failure_never_breaks_capture(project):
    class Boom(FakeChromeDriver):
        def execute_script(self, script, *args):
            if "collectElementMap" in script:
                raise RuntimeError("CSP blocked")
            return super().execute_script(script, *args)

    witness(Boom(), "map-fails")
    temp = project / ".testivai" / "temp" / "map-fails"
    assert (temp / "screenshot.png").exists()
    assert not (temp / "elements.json").exists()


# ── Pins for the witness() split ────────────────────────────────────────────
#
# witness() is split into helpers before capture health and provenance are
# added (the repo's complexity rule). These pin what it does today, so the
# split cannot change it.


class LoggingChromeDriver(FakeChromeDriver):
    """FakeChromeDriver that records the order of the calls witness() makes."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.log: list[str] = []

    def execute_script(self, script, *args):
        for marker, event in (
            ("createElement('style')", "add_style"),
            ("getElementById", "remove_style"),
            ("document.fonts", "fonts"),
            ("settleProbe", "settle"),
            ("__testivaiSettleState", "stop_settle"),
            ("collectElementMap", "element_map"),
            ("cloneNode", "dom"),
        ):
            if marker in script:
                self.log.append(event)
                break
        return super().execute_script(script, *args)

    def execute_cdp_cmd(self, cmd, params):
        self.log.append("screenshot")
        return super().execute_cdp_cmd(cmd, params)


def test_capture_order(project):
    driver = LoggingChromeDriver()
    witness(driver, "order")
    assert driver.log == [
        "add_style", "fonts", "settle", "screenshot",
        "remove_style", "stop_settle", "dom", "element_map",
    ]


def test_no_settle_wait_or_observer_cleanup_without_stabilize(project):
    driver = LoggingChromeDriver()
    witness(driver, "x", stabilize=False, ignore_selectors=[".ad"])
    assert driver.injected_css == [".ad { visibility: hidden !important; }"]
    assert driver.log == ["add_style", "screenshot", "remove_style", "dom", "element_map"]


def test_nothing_injected_or_removed_without_stabilize_or_selectors(project):
    driver = LoggingChromeDriver()
    witness(driver, "plain", stabilize=False)
    assert driver.log == ["screenshot", "dom", "element_map"]


def test_locked_down_page_skips_style_removal(project):
    class Locked(LoggingChromeDriver):
        def execute_script(self, script, *args):
            if "createElement('style')" in script:
                raise RuntimeError("CSP")
            return super().execute_script(script, *args)

    driver = Locked()
    temp = witness(driver, "locked")
    assert (temp / "screenshot.png").read_bytes() == PNG
    assert "remove_style" not in driver.log
    assert driver.log[:2] == ["fonts", "settle"]  # still waited for


def test_style_removed_and_observer_stopped_when_every_screenshot_fails(project):
    class Broken(LoggingChromeDriver):
        def get_screenshot_as_png(self):
            raise RuntimeError("no screenshot")

    driver = Broken(fail_cdp=True)
    with pytest.raises(RuntimeError, match="no screenshot"):
        witness(driver, "broken")
    assert driver.style_removed
    assert "stop_settle" in driver.log


def test_dom_snapshot_failure_never_breaks_capture(project):
    class Boom(FakeChromeDriver):
        def execute_script(self, script, *args):
            if "cloneNode" in script:
                raise RuntimeError("navigated away")
            return super().execute_script(script, *args)

    temp = witness(Boom(), "dom-fails")
    assert (temp / "screenshot.png").exists()
    assert not (temp / "dom.html").exists()
    assert (temp / "elements.json").exists()  # the map is taken on its own


@pytest.mark.parametrize("value", ["", None, 42])
def test_empty_or_non_string_dom_is_not_written(project, value):
    class Odd(FakeChromeDriver):
        def execute_script(self, script, *args):
            if "cloneNode" in script:
                return value
            return super().execute_script(script, *args)

    assert not (witness(Odd(), "odd") / "dom.html").exists()


@pytest.mark.parametrize("value", [[], None, {"a": 1}])
def test_empty_or_non_list_element_map_is_not_written(project, value):
    class Odd(FakeChromeDriver):
        def execute_script(self, script, *args):
            if "collectElementMap" in script:
                return value
            return super().execute_script(script, *args)

    assert not (witness(Odd(), "odd") / "elements.json").exists()


def test_element_map_gets_max_elements_and_the_merged_selectors(project):
    write_config(project, ignoreSelectors=[".a"])
    driver = FakeChromeDriver()
    witness(driver, "x", ignore_selectors=[".b", ".a"], max_elements=50)
    expr = next(s for s, _ in driver.scripts if "collectElementMap" in s)
    assert expr.endswith('(document, window, 50, [".a", ".b"]);')


def test_element_map_defaults_to_3000_elements(project):
    driver = FakeChromeDriver()
    witness(driver, "x")
    expr = next(s for s, _ in driver.scripts if "collectElementMap" in s)
    assert expr.endswith("(document, window, 3000, []);")


def test_project_root_overrides_cwd(project, tmp_path_factory):
    elsewhere = tmp_path_factory.mktemp("elsewhere")
    temp = witness(FakeChromeDriver(), "rooted", project_root=elsewhere)
    assert temp == elsewhere / ".testivai" / "temp" / "rooted"
    assert not (project / ".testivai").exists()


@pytest.mark.parametrize("name", [None, 7, ""])
def test_non_string_or_empty_name_rejected(project, name):
    with pytest.raises(ValueError, match="snapshot name is required"):
        witness(FakeChromeDriver(), name)
