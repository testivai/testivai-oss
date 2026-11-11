"""
Unit tests for the Python capture adapter. The Page object is duck-typed, so
a fake exercises the full capture flow without a browser — same approach as
the WebdriverIO adapter's tests.
"""

import json
from pathlib import Path

import pytest

from testivai import STABILIZE_CSS, build_ignore_css, load_local_config, sanitize_variant, witness


class FakeStyleHandle:
    def __init__(self):
        self.removed = False

    def evaluate(self, script):
        if "remove" in script:
            self.removed = True


class FakePage:
    """Duck-typed playwright.sync_api.Page covering witness()'s surface."""

    PNG = b"\x89PNG\r\n\x1a\nfakepixels"

    def __init__(self, dom="<html><head></head><body><p>Hi</p></body></html>", fail_screenshot=False):
        self.dom = dom
        self.fail_screenshot = fail_screenshot
        self.styles: list[str] = []
        self.handles: list[FakeStyleHandle] = []
        self.evaluated: list[tuple] = []

    def add_style_tag(self, content):
        self.styles.append(content)
        handle = FakeStyleHandle()
        self.handles.append(handle)
        return handle

    def evaluate(self, script, arg=None):
        self.evaluated.append((script, arg))
        if "document.fonts" in script:
            return True
        if "cloneNode" in script:
            # simulate exclusion: drop any selector's text crudely for assertions
            dom = self.dom
            for sel in arg or []:
                dom = dom.replace(f'<div class="{sel.lstrip(".")}">SECRET</div>', "")
            return dom
        return None

    def screenshot(self, path, full_page):
        assert full_page is True
        if self.fail_screenshot:
            raise RuntimeError("boom")
        Path(path).write_bytes(self.PNG)


@pytest.fixture()
def project(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def write_config(root: Path, **overrides):
    cfg = {"mode": "local", **overrides}
    (root / ".testivai").mkdir(parents=True, exist_ok=True)
    (root / ".testivai" / "config.json").write_text(json.dumps(cfg))


def test_writes_screenshot_and_dom(project):
    page = FakePage()
    temp = witness(page, "homepage")

    assert temp == project / ".testivai" / "temp" / "homepage"
    assert (temp / "screenshot.png").read_bytes() == FakePage.PNG
    assert "<p>Hi</p>" in (temp / "dom.html").read_text()


def test_stabilization_css_injected_and_removed(project):
    page = FakePage()
    witness(page, "x")

    assert any("animation-duration: 0.001s" in s for s in page.styles)
    assert all(h.removed for h in page.handles)
    # fonts were awaited
    assert any("document.fonts" in script for script, _ in page.evaluated)


def test_stabilize_false_via_config(project):
    write_config(project, stabilize=False)
    page = FakePage()
    witness(page, "x")

    assert page.styles == []


def test_per_call_stabilize_override_wins(project):
    write_config(project, stabilize=True)
    page = FakePage()
    witness(page, "x", stabilize=False)
    assert page.styles == []


def test_ignore_selectors_merged_and_passed_to_dom_snapshot(project):
    write_config(project, ignoreSelectors=[".from-config"])
    page = FakePage(dom='<html><body><div class="badge">SECRET</div><p>Hi</p></body></html>')
    witness(page, "x", ignore_selectors=[".badge"])

    injected = "\n".join(page.styles)
    assert ".from-config { visibility: hidden !important; }" in injected
    assert ".badge { visibility: hidden !important; }" in injected

    # the DOM snapshot script received the merged selector list
    dom_calls = [arg for script, arg in page.evaluated if "cloneNode" in script]
    assert dom_calls == [[".from-config", ".badge"]]


def test_variant_folds_into_name(project):
    page = FakePage()
    temp = witness(page, "homepage", variant="Firefox Mobile @2x")
    assert temp.name == "homepage__firefox_mobile_2x"


def test_skip_dom(project):
    page = FakePage()
    temp = witness(page, "no-dom", skip_dom=True)
    assert (temp / "screenshot.png").exists()
    assert not (temp / "dom.html").exists()


def test_style_removed_even_when_screenshot_fails(project):
    page = FakePage(fail_screenshot=True)
    with pytest.raises(RuntimeError, match="boom"):
        witness(page, "explodes")
    assert all(h.removed for h in page.handles)


def test_empty_name_rejected(project):
    with pytest.raises(ValueError):
        witness(FakePage(), "")


def test_helpers():
    assert sanitize_variant("Desktop Chrome @ 2x") == "desktop_chrome_2x"
    assert "visibility: hidden" in build_ignore_css([".x"])
    assert "caret-color: transparent" in STABILIZE_CSS
    cfg = load_local_config(Path("/nonexistent"))
    assert cfg["stabilize"] is True and cfg["threshold"] == 0.1


def test_resolve_cli_prefers_project_local_bin(project, monkeypatch):
    from testivai import resolve_cli

    local_bin = project / "node_modules" / ".bin"
    local_bin.mkdir(parents=True)
    cli = local_bin / "testivai"
    cli.write_text("#!/bin/sh\n")
    cli.chmod(0o755)
    monkeypatch.delenv("TESTIVAI_CLI", raising=False)

    assert resolve_cli() == [str(cli)]  # project-local beats any global PATH


def test_resolve_cli_env_override(project, monkeypatch):
    from testivai import resolve_cli

    monkeypatch.setenv("TESTIVAI_CLI", "node /x/testivai.js")
    assert resolve_cli() == ["node", "/x/testivai.js"]


# ── Pins for the witness() split ────────────────────────────────────────────
#
# witness() is split into helpers before capture health and provenance are
# added (the repo's complexity rule). These pin what it does today, so the
# split cannot change it.


class LoggingPage(FakePage):
    """FakePage that records the order of the calls witness() makes."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.log: list[str] = []

    def add_style_tag(self, content):
        self.log.append("add_style")
        handle = super().add_style_tag(content)
        log = self.log
        original = handle.evaluate

        def evaluate(script):
            log.append("remove_style")
            original(script)

        handle.evaluate = evaluate
        return handle

    def evaluate(self, script, arg=None):
        if "document.fonts" in script:
            self.log.append("fonts")
        elif "cloneNode" in script:
            self.log.append("dom")
        return super().evaluate(script, arg)

    def screenshot(self, path, full_page):
        self.log.append("screenshot")
        super().screenshot(path, full_page)


def test_capture_order_style_fonts_screenshot_unstyle_then_dom(project):
    page = LoggingPage()
    witness(page, "order")
    assert page.log == ["add_style", "fonts", "screenshot", "remove_style", "dom"]


def test_ignore_selectors_without_stabilize_inject_only_the_ignore_css(project):
    page = LoggingPage()
    witness(page, "x", stabilize=False, ignore_selectors=[".ad"])
    assert page.styles == [".ad { visibility: hidden !important; }"]
    assert page.log == ["add_style", "screenshot", "remove_style", "dom"]  # no font wait


def test_duplicate_selectors_kept_once_in_first_seen_order(project):
    write_config(project, ignoreSelectors=[".a", ".b"])
    page = FakePage()
    witness(page, "x", ignore_selectors=[".b", ".c", ".a"])
    dom_calls = [arg for script, arg in page.evaluated if "cloneNode" in script]
    assert dom_calls == [[".a", ".b", ".c"]]


def test_locked_down_page_without_style_tags_still_captures(project):
    class Locked(LoggingPage):
        def add_style_tag(self, content):
            raise RuntimeError("CSP")

    page = Locked()
    temp = witness(page, "locked")
    assert (temp / "screenshot.png").read_bytes() == FakePage.PNG
    assert (temp / "dom.html").exists()
    assert page.log == ["fonts", "screenshot", "dom"]  # fonts still awaited


def test_dom_snapshot_failure_never_breaks_capture(project):
    class Boom(FakePage):
        def evaluate(self, script, arg=None):
            if "cloneNode" in script:
                raise RuntimeError("navigated away")
            return super().evaluate(script, arg)

    temp = witness(Boom(), "dom-fails")
    assert (temp / "screenshot.png").exists()
    assert not (temp / "dom.html").exists()


@pytest.mark.parametrize("dom", ["", None, 42])
def test_empty_or_non_string_dom_is_not_written(project, dom):
    class Odd(FakePage):
        def evaluate(self, script, arg=None):
            if "cloneNode" in script:
                return dom
            return super().evaluate(script, arg)

    temp = witness(Odd(), "odd-dom")
    assert not (temp / "dom.html").exists()


def test_project_root_overrides_cwd(project, tmp_path_factory):
    elsewhere = tmp_path_factory.mktemp("elsewhere")
    temp = witness(FakePage(), "rooted", project_root=elsewhere)
    assert temp == elsewhere / ".testivai" / "temp" / "rooted"
    assert not (project / ".testivai").exists()


@pytest.mark.parametrize("name", [None, 7, ""])
def test_non_string_or_empty_name_rejected(project, name):
    with pytest.raises(ValueError, match="snapshot name is required"):
        witness(FakePage(), name)
