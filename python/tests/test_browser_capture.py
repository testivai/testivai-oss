"""
The Python adapters against a real browser: a page whose stylesheet answers
404 must leave a failure in the capture's `health`, a healthy page must not,
and `environment` must name the browser the capture ran in.

Three ways in, from most to least available:
  - playwright-python with Chromium;
  - the Selenium adapter in a real Chromium, driven through a stand-in for
    WebDriver that answers execute_script and execute_cdp_cmd with Playwright
    (the adapter's own scripts run in the page; the WebDriver wire protocol
    does not);
  - Selenium WebDriver itself, which needs a chromedriver that matches the
    browser.

TESTIVAI_CHROME_PATH points at a Chromium or Chrome build to use. Without a
browser, Playwright or Selenium these tests skip, unless
TESTIVAI_BROWSER_TESTS=required (CI sets it), when they fail.
"""

import functools
import http.server
import json
import os
import shutil
import struct
import subprocess
import threading
from pathlib import Path

import pytest

from testivai._capture import witness as pw_witness
from testivai._environment import collect_host_environment
from testivai.selenium import witness as se_witness

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "packages" / "witness" / "dist" / "bin" / "testivai.js"
REQUIRED = os.environ.get("TESTIVAI_BROWSER_TESTS") == "required"

PAGE = """<!doctype html>
<html><head><link rel="stylesheet" href="/{css}"></head>
<body style="margin:0"><h1>Hello</h1><div style="height:1500px"></div></body></html>
"""


def unavailable(message):
    if REQUIRED:
        pytest.fail(message)
    pytest.skip(message)


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    """A local site: /healthy.html (its stylesheet loads) and /broken.html (its stylesheet answers 404)."""
    root = tmp_path_factory.mktemp("site")
    (root / "healthy.html").write_text(PAGE.format(css="site.css"))
    (root / "broken.html").write_text(PAGE.format(css="missing.css"))
    (root / "site.css").write_text("h1 { color: rgb(200, 0, 0); font-size: 64px; }")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(_Quiet, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture()
def project(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


@pytest.fixture(scope="module")
def chromium():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        unavailable("playwright is not installed (pip install testivai[playwright])")
    pw = sync_playwright().start()
    try:
        path = os.environ.get("TESTIVAI_CHROME_PATH")
        browser = pw.chromium.launch(**({"executable_path": path} if path else {}))
    except Exception as err:  # no browser installed for this Playwright
        pw.stop()
        unavailable(f"Chromium did not start: {str(err).splitlines()[0]}")
    yield browser
    browser.close()
    pw.stop()


@pytest.fixture()
def page(chromium):
    context = chromium.new_context(viewport={"width": 800, "height": 600})
    yield context.new_page()
    context.close()


def metadata(temp_dir):
    return json.loads((temp_dir / "metadata.json").read_text())


def png_size(path):
    data = Path(path).read_bytes()
    return struct.unpack(">II", data[16:24])


def assert_failed_stylesheet(health, site):
    url = f"{site}/missing.css"
    assert health["stylesheets"] == {"failed": 1, "urls": [url]}
    assert health["resources"] == {"status": "checked", "failed": {"css": {"count": 1, "entries": [{"url": url, "status": 404}]}}}


def assert_nothing_failed(health):
    assert health["fonts"] == {"status": "loaded", "failed": []}
    assert health["stylesheets"] == {"failed": 0, "urls": []}
    assert health["images"] == {"broken": 0, "urls": []}
    assert health["resources"] == {"status": "checked", "failed": {}}


# ── playwright-python ──────────────────────────────────────────────────────


class TestPlaywright:
    def test_a_stylesheet_that_answers_404_is_recorded(self, project, page, site):
        page.goto(f"http://{site}/broken.html")
        assert_failed_stylesheet(metadata(pw_witness(page, "broken"))["health"], site)

    def test_a_healthy_page_records_health_with_no_failure(self, project, page, site):
        page.goto(f"http://{site}/healthy.html")
        assert_nothing_failed(metadata(pw_witness(page, "healthy"))["health"])

    def test_the_environment_names_this_browser_and_machine(self, project, page, site, chromium):
        page.goto(f"http://{site}/healthy.html")
        env = metadata(pw_witness(page, "env", variant="desktop"))["environment"]
        assert env["os"] == collect_host_environment()["os"]
        assert env["browser"]["name"] == "chromium"
        assert env["browser"]["version"] == chromium.version
        assert env["adapter"]["captureMethod"] == "full-page:playwright"
        assert env["render"]["viewport"] == {"width": 800, "height": 600}
        assert env["render"]["deviceScaleFactor"] == 1
        assert env["project"] == "desktop"


# ── Selenium adapter, real Chromium, Playwright standing in for WebDriver ──


class PlaywrightBackedWebDriver:
    """
    The part of Selenium's WebDriver the adapter uses, answered by Playwright:
    execute_script runs its body as Selenium does (a function body, with
    `arguments`), execute_cdp_cmd goes to a CDP session.
    """

    def __init__(self, page, version):
        self.page = page
        self.cdp = page.context.new_cdp_session(page)
        self.capabilities = {"browserName": "chrome", "browserVersion": version}

    def execute_script(self, script, *args):
        return self.page.evaluate("([body, args]) => new Function(body).apply(window, args)", [script, list(args)])

    def execute_cdp_cmd(self, cmd, params):
        return self.cdp.send(cmd, params)

    def get_screenshot_as_png(self):
        return self.page.screenshot()


class TestSeleniumAdapterInChromium:
    def test_a_stylesheet_that_answers_404_is_recorded(self, project, page, site, chromium):
        page.goto(f"http://{site}/broken.html")
        temp = se_witness(PlaywrightBackedWebDriver(page, chromium.version), "broken")
        assert_failed_stylesheet(metadata(temp)["health"], site)

    def test_a_healthy_page_records_health_with_no_failure(self, project, page, site, chromium):
        page.goto(f"http://{site}/healthy.html")
        temp = se_witness(PlaywrightBackedWebDriver(page, chromium.version), "healthy")
        meta = metadata(temp)
        assert_nothing_failed(meta["health"])
        assert meta["environment"]["adapter"]["captureMethod"] == "full-page:cdp"
        assert meta["environment"]["browser"] == {"name": "chromium", "version": chromium.version, "channel": "chrome"}
        assert png_size(temp / "screenshot.png")[1] > 600  # the full page, not the viewport


# ── Selenium WebDriver ─────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def chrome_driver():
    try:
        from selenium import webdriver
    except ImportError:
        unavailable("selenium is not installed (pip install testivai[selenium])")
    options = webdriver.ChromeOptions()
    for arg in ("--headless=new", "--no-sandbox", "--window-size=800,600"):
        options.add_argument(arg)
    if os.environ.get("TESTIVAI_CHROME_PATH"):
        options.binary_location = os.environ["TESTIVAI_CHROME_PATH"]
    try:
        driver = webdriver.Chrome(options=options)
    except Exception as err:  # no chromedriver that matches this browser
        unavailable(f"Chrome WebDriver did not start: {str(err).splitlines()[0]}")
    yield driver
    driver.quit()


class TestSeleniumWebDriver:
    def test_a_stylesheet_that_answers_404_is_recorded(self, project, chrome_driver, site):
        chrome_driver.get(f"http://{site}/broken.html")
        assert_failed_stylesheet(metadata(se_witness(chrome_driver, "broken"))["health"], site)

    def test_a_healthy_page_records_health_with_no_failure(self, project, chrome_driver, site):
        chrome_driver.get(f"http://{site}/healthy.html")
        meta = metadata(se_witness(chrome_driver, "healthy"))
        assert_nothing_failed(meta["health"])
        env = meta["environment"]
        assert env["browser"]["name"] == "chromium"
        assert env["browser"]["version"] == chrome_driver.capabilities["browserVersion"]
        assert env["browser"]["headless"] is True
        assert env["driver"]["name"] == "chromedriver"
        assert env["adapter"]["captureMethod"] == "full-page:cdp"


# ── The compare reads it ───────────────────────────────────────────────────


def test_the_compare_calls_a_capture_with_a_failed_stylesheet_unhealthy(project, page, site):
    """
    Healthy baseline, then the stylesheet 404s: `testivai report` (the real
    compare, from packages/witness) must say the capture is unhealthy, not
    render noise, from what the Python adapter recorded.
    """
    if shutil.which("node") is None or not CLI.exists():
        unavailable("the testivai CLI is not built (pnpm --filter @testivai/witness build)")

    def cli(*args):
        return subprocess.run(["node", str(CLI), *args], cwd=project, capture_output=True, text=True, timeout=120)

    page.goto(f"http://{site}/healthy.html")
    pw_witness(page, "home")
    assert cli("approve", "--all").returncode == 0
    baseline = json.loads((project / ".testivai" / "baselines" / "home" / "metadata.json").read_text())
    assert baseline["health"]["stylesheets"]["failed"] == 0  # frozen into the baseline on approve
    assert baseline["environment"]["adapter"]["name"] == "testivai"

    page.goto(f"http://{site}/broken.html")
    pw_witness(page, "home")
    result = cli("report", "--json")
    snapshot = next(s for s in json.loads(result.stdout)["snapshots"] if s["name"] == "home")
    assert snapshot["status"] == "changed"
    assert snapshot["captureHealth"]["unhealthy"] == "candidate"
    assert any("missing.css" in reason for reason in snapshot["captureHealth"]["reasons"])
    assert snapshot["dom"]["noiseHint"] is False
