"""
What the Python adapters record in the capture's metadata.json: capture
provenance (`environment`) and capture health (`health`), the two optional
parts of the contract in docs/extension-api.md, written as the JS adapters
write them.

Fakes stand in for the browser here; test_browser_capture.py runs the same
adapters against a real one.
"""

import base64
import json

import pytest

import testivai
from testivai import _environment
from testivai._capture import witness as pw_witness
from testivai._environment import collect_host_environment
from testivai._probes import HEALTH_PROBE, RENDER_PROBE
from testivai.selenium import witness as se_witness

PNG = b"\x89PNG\r\n\x1a\nfakepixels"
CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36"
RENDER = {"viewport": {"width": 1280, "height": 720}, "deviceScaleFactor": 1, "colorScheme": "light",
          "reducedMotion": "no-preference", "locale": "en-US", "timezone": "UTC", "userAgent": CHROME_UA}
RENDER_BLOCK = {k: v for k, v in RENDER.items() if k != "userAgent"}
HEALTHY = {
    "fonts": {"status": "loaded", "failed": []},
    "stylesheets": {"failed": 0, "urls": []},
    "images": {"broken": 0, "urls": []},
    "resources": {"status": "checked", "failed": {}},
}
BROKEN_STYLESHEET = {
    **HEALTHY,
    "stylesheets": {"failed": 1, "urls": ["localhost:3000/missing.css"]},
    "resources": {"status": "checked", "failed": {"css": {"count": 1, "entries": [{"url": "localhost:3000/missing.css", "status": 404}]}}},
}


@pytest.fixture()
def project(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(_environment, "package_version", lambda name: {"playwright": "1.65.0", "selenium": "4.52.0"}.get(name))
    return tmp_path


def metadata(temp_dir):
    return json.loads((temp_dir / "metadata.json").read_text())


# ── playwright-python ──────────────────────────────────────────────────────


class FakeBrowser:
    class browser_type:  # noqa: N801 - mirrors playwright's attribute
        name = "chromium"

    version = "153.0.8010.12"


class FakeContext:
    def __init__(self, browser):
        self.browser = browser


class FakeHandle:
    def __init__(self, log):
        self.log = log

    def evaluate(self, script):
        self.log.append("remove_style")


class FakePage:
    """Duck-typed playwright.sync_api.Page that answers the two probes."""

    def __init__(self, health=HEALTHY, render=RENDER, browser=FakeBrowser()):
        self.health = health
        self.render = render
        self.context = FakeContext(browser)
        self.log: list[str] = []

    def add_style_tag(self, content):
        self.log.append("add_style")
        return FakeHandle(self.log)

    def evaluate(self, script, arg=None):
        if script == HEALTH_PROBE.expression():
            self.log.append("health")
            return self._answer(self.health)
        if script == RENDER_PROBE.expression():
            self.log.append("render")
            return self._answer(self.render)
        if "document.fonts" in script:
            return True
        if "cloneNode" in script:
            self.log.append("dom")
            return "<html><body><p>Hi</p></body></html>"
        return None

    @staticmethod
    def _answer(value):
        if isinstance(value, Exception):
            raise value
        return value

    def screenshot(self, path, full_page):
        self.log.append("screenshot")
        open(path, "wb").write(PNG)


class TestPlaywrightMetadata:
    def test_records_environment_and_health_as_the_js_adapters_do(self, project, monkeypatch):
        monkeypatch.setenv("PYTEST_CURRENT_TEST", "test_x.py::test_home (call)")
        temp = pw_witness(FakePage(), "home")
        assert metadata(temp) == {
            "name": "home",
            "environment": {
                "os": collect_host_environment()["os"],
                "browser": {"name": "chromium", "version": "153.0.8010.12", "headless": True},
                "framework": {"name": "playwright", "version": "1.65.0", "language": "python", "runner": "pytest"},
                "adapter": {"name": "testivai", "version": testivai.__version__, "captureMethod": "full-page:playwright"},
                "render": RENDER_BLOCK,
                **{k: v for k, v in collect_host_environment().items() if k != "os"},
            },
            "health": HEALTHY,
        }

    def test_a_failed_stylesheet_is_recorded(self, project):
        temp = pw_witness(FakePage(health=BROKEN_STYLESHEET), "broken")
        assert metadata(temp)["health"] == BROKEN_STYLESHEET

    def test_render_is_read_before_the_styles_go_on_and_health_after_the_screenshot_before_they_come_off(self, project):
        page = FakePage()
        pw_witness(page, "order")
        assert page.log == ["render", "add_style", "screenshot", "health", "remove_style", "dom"]

    def test_health_is_probed_even_with_nothing_injected(self, project):
        page = FakePage()
        pw_witness(page, "plain", stabilize=False)
        assert page.log == ["render", "screenshot", "health", "dom"]

    @pytest.mark.parametrize("answer", [RuntimeError("navigated away"), None, {"fonts": "?"}, "healthy"])
    def test_a_probe_that_fails_or_answers_nonsense_records_no_health(self, project, answer):
        temp = pw_witness(FakePage(health=answer), "unchecked")
        assert (temp / "screenshot.png").exists()
        assert "health" not in metadata(temp)  # not checked, never healthy
        assert metadata(temp)["environment"]["browser"]["name"] == "chromium"

    def test_without_the_render_probe_the_environment_has_no_render(self, project):
        temp = pw_witness(FakePage(render=RuntimeError("csp")), "norender")
        env = metadata(temp)["environment"]
        assert "render" not in env
        assert env["browser"] == {"name": "chromium", "version": "153.0.8010.12"}

    def test_a_persistent_context_has_no_browser_the_user_agent_names_it(self, project):
        temp = pw_witness(FakePage(browser=None), "persistent")
        assert metadata(temp)["environment"]["browser"] == {"name": "chromium", "version": "153.0.8010.12", "headless": True}

    def test_the_variant_is_the_project_and_the_name_is_the_folded_one(self, project):
        temp = pw_witness(FakePage(), "home", variant="Mobile Safari")
        assert metadata(temp)["name"] == "home__mobile_safari"
        assert metadata(temp)["environment"]["project"] == "Mobile Safari"

    def test_no_runner_outside_pytest(self, project, monkeypatch):
        monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
        temp = pw_witness(FakePage(), "script")
        assert "runner" not in metadata(temp)["environment"]["framework"]

    def test_each_capture_writes_its_metadata_fresh(self, project):
        # A health block from an earlier run must not survive a run that could not check.
        pw_witness(FakePage(health=BROKEN_STYLESHEET), "again")
        temp = pw_witness(FakePage(health=RuntimeError("gone")), "again")
        assert "health" not in metadata(temp)

    def test_metadata_that_cannot_be_written_never_breaks_the_capture(self, project):
        blocked = project / ".testivai" / "temp" / "blocked" / "metadata.json"
        blocked.mkdir(parents=True)  # a directory where the file goes
        temp = pw_witness(FakePage(), "blocked")
        assert (temp / "screenshot.png").read_bytes() == PNG


# ── Selenium ───────────────────────────────────────────────────────────────


class FakeDriver:
    """Duck-typed Chrome WebDriver that answers the two probes."""

    capabilities = {
        "browserName": "chrome",
        "browserVersion": "153.0.8010.12",
        "goog:chromeOptions": {"args": ["--headless=new"]},
        "chrome": {"chromedriverVersion": "153.0.8010.12 (abc-refs/branch-heads/8010@{#1})"},
    }

    def __init__(self, health=HEALTHY, render=RENDER, fail_cdp=False):
        self.health = health
        self.render = render
        self.fail_cdp = fail_cdp
        self.log: list[str] = []

    def execute_script(self, script, *args):
        if script == HEALTH_PROBE.for_webdriver():
            self.log.append("health")
            return FakePage._answer(self.health)
        if script == RENDER_PROBE.for_webdriver():
            self.log.append("render")
            return FakePage._answer(self.render)
        for marker, event in (("createElement('style')", "add_style"), ("getElementById", "remove_style"), ("cloneNode", "dom")):
            if marker in script:
                self.log.append(event)
        if "document.fonts" in script:
            return True
        if "cloneNode" in script:
            return "<html></html>"
        return None

    def execute_cdp_cmd(self, cmd, params):
        self.log.append("screenshot")
        if self.fail_cdp:
            raise RuntimeError("cdp boom")
        return {"data": base64.b64encode(PNG).decode()}

    def get_screenshot_as_png(self):
        self.log.append("viewport_screenshot")
        return PNG


class FakeFirefox(FakeDriver):
    capabilities = {"browserName": "firefox", "browserVersion": "143.0", "moz:geckodriverVersion": "0.36.0"}
    execute_cdp_cmd = None

    def get_full_page_screenshot_as_png(self):
        self.log.append("firefox_screenshot")
        return PNG


class FakeSafari(FakeDriver):
    capabilities = {"browserName": "safari", "browserVersion": "26.0"}
    execute_cdp_cmd = None


class TestSeleniumMetadata:
    def test_records_environment_and_health_from_the_capabilities(self, project, monkeypatch):
        monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
        temp = se_witness(FakeDriver(), "home", skip_element_map=True)
        meta = metadata(temp)
        assert meta["name"] == "home"
        assert meta["health"] == HEALTHY
        env = meta["environment"]
        assert env["browser"] == {"name": "chromium", "version": "153.0.8010.12", "channel": "chrome", "headless": True}
        assert env["framework"] == {"name": "selenium", "version": "4.52.0", "language": "python"}
        assert env["adapter"] == {"name": "testivai", "version": testivai.__version__, "captureMethod": "full-page:cdp"}
        assert env["driver"] == {"name": "chromedriver", "version": "153.0.8010.12"}
        assert env["render"] == RENDER_BLOCK
        assert env["os"] == collect_host_environment()["os"]

    @pytest.mark.parametrize(
        "driver, method",
        [(FakeDriver(), "full-page:cdp"), (FakeDriver(fail_cdp=True), "viewport:webdriver"),
         (FakeFirefox(), "full-page:firefox"), (FakeSafari(), "viewport:webdriver")],
        ids=["chrome cdp", "chrome after a cdp failure", "firefox", "safari"],
    )
    def test_the_capture_method_is_the_one_that_took_the_screenshot(self, project, driver, method):
        temp = se_witness(driver, "m", skip_element_map=True)
        assert metadata(temp)["environment"]["adapter"]["captureMethod"] == method

    def test_render_before_the_styles_and_health_after_the_screenshot_before_they_come_off(self, project):
        driver = FakeDriver()
        se_witness(driver, "order", skip_element_map=True)
        assert driver.log == ["render", "add_style", "screenshot", "health", "remove_style", "dom"]

    def test_a_failed_stylesheet_is_recorded(self, project):
        temp = se_witness(FakeDriver(health=BROKEN_STYLESHEET), "broken", skip_element_map=True)
        assert metadata(temp)["health"] == BROKEN_STYLESHEET

    @pytest.mark.parametrize("answer", [RuntimeError("stale element"), None, {"fonts": "?"}])
    def test_a_probe_that_fails_or_answers_nonsense_records_no_health(self, project, answer):
        temp = se_witness(FakeDriver(health=answer), "unchecked", skip_element_map=True)
        assert "health" not in metadata(temp)

    def test_no_environment_when_nothing_names_the_browser(self, project):
        class Anonymous(FakeDriver):
            capabilities = {}

        temp = se_witness(Anonymous(render={"userAgent": "curl/8"}), "anon", skip_element_map=True)
        assert metadata(temp) == {"name": "anon", "health": HEALTHY}

    def test_capabilities_that_raise_fall_back_to_the_user_agent(self, project):
        class Raising(FakeDriver):
            @property
            def capabilities(self):
                raise RuntimeError("session gone")

        temp = se_witness(Raising(), "ua", skip_element_map=True)
        assert metadata(temp)["environment"]["browser"] == {"name": "chromium", "version": "153.0.8010.12", "headless": True}
