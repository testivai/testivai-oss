"""
The Python ports of the provenance and health helpers must give exactly what
the TypeScript originals give, because the compare reads a Python capture
against a baseline any adapter may have taken. Each test here runs the
built JS helper (packages/witness/dist) and the Python one on the same input
and compares the JSON, key order included.

Needs Node and `pnpm --filter @testivai/witness build`. Without them these
tests skip, unless TESTIVAI_PARITY_TESTS=required (CI sets it), when they fail.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from testivai._environment import (
    EnvironmentParts,
    browser_from_capabilities,
    browser_from_user_agent,
    build_capture_environment,
    collect_host_environment,
    detect_ci,
    distro_from_os_release,
    parse_render_probe,
)
from testivai._health import parse_health

DIST = Path(__file__).resolve().parents[2] / "packages" / "witness" / "dist" / "capture"


def _js_available():
    missing = []
    if shutil.which("node") is None:
        missing.append("node")
    if not (DIST / "environment.js").exists() or not (DIST / "health.js").exists():
        missing.append("packages/witness/dist (run `pnpm --filter @testivai/witness build`)")
    return missing


@pytest.fixture(scope="module", autouse=True)
def js_helpers():
    missing = _js_available()
    if missing:
        message = "JS helpers unavailable: " + ", ".join(missing)
        if os.environ.get("TESTIVAI_PARITY_TESTS") == "required":
            pytest.fail(message)
        pytest.skip(message)


def run_js(function, inputs, env=None):
    """Map `inputs` through a function exported by @testivai/witness's capture modules."""
    script = (
        "const m = Object.assign({}, require(process.argv[1] + '/environment.js'), require(process.argv[1] + '/health.js'));"
        "const inputs = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
        f"const out = inputs.map((args) => {{ const r = m[{json.dumps(function)}](...args); return r === undefined ? null : r; }});"
        "process.stdout.write(JSON.stringify(out));"
    )
    proc = subprocess.run(
        ["node", "-e", script, str(DIST)],
        input=json.dumps(inputs), capture_output=True, text=True, timeout=60, env=env,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def same(js_values, py_values):
    """Equal as JSON, key order included."""
    dump = lambda v: json.dumps(v, ensure_ascii=False)  # noqa: E731
    assert [dump(v) for v in py_values] == [dump(v) for v in js_values]


USER_AGENTS = [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57",
    "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    "Mozilla/5.0 Chromium/120.0.1 Safari/537.36",
    "SomeTool Version/2.1",
    "Version/1.0 Firefox/",
    "Version/26.0Safari/605.1.15",  # \b right after the version
    "éChrome/1.0",  # \b is ASCII in JS
    "Chrome/١٢",  # \d is ASCII in JS
    "Version/" + "." * 5000,
    "curl/8.5.0",
    "",
]

CAPABILITIES = [
    {"browserName": "chrome", "browserVersion": "141.0.7390.37", "goog:chromeOptions": {"args": ["--headless=new"]},
     "chrome": {"chromedriverVersion": "141.0.7390.37 (2b1b84a5-refs/branch-heads/7390@{#1})"}},
    {"browserName": "MicrosoftEdge", "browserVersion": "141.0.3537.57", "msedge": {"msedgedriverVersion": "141.0.3537.57 (abc)"}},
    {"browserName": "firefox", "browserVersion": "143.0", "moz:firefoxOptions": {"args": ["-headless"]}, "moz:geckodriverVersion": "0.36.0"},
    {"browserName": "Safari", "browserVersion": "26.0"},
    {"browserName": "chrome-headless-shell", "browserVersion": "1"},
    {"browserName": "chrome", "browserVersion": "1", "goog:chromeOptions": {"args": []}},
    # what a real chromedriver session returns: no args, only the debugger address
    {"browserName": "chrome", "browserVersion": "153.0.8010.12", "goog:chromeOptions": {"debuggerAddress": "localhost:40169"},
     "chrome": {"chromedriverVersion": "153.0.8010.12 (6d3f-refs/branch-heads/8010@{#12})", "userDataDir": "/tmp/x"}},
    {"browserName": "chrome", "browserVersion": "1", "goog:chromeOptions": {"args": ["--headless\n", 7, "--headless-ish"]}},
    {"browserName": "chrome", "goog:chromeOptions": "not an object"},
    {"browserName": "chrome", "browserVersion": "", "version": "9"},
    {"browserName": "chrome", "version": "99.0"},
    {"browserName": "chrome", "chrome": {"chromedriverVersion": "   "}},
    {"browserName": "chrome", "chrome": "141"},
    {"browserName": "firefox", "moz:geckodriverVersion": 36},
    {"browserName": "Servo", "browserVersion": "0.1"},
    {"browserName": ""},
    {"browserName": 3},
    {},
    None,
    [],
]

OS_RELEASES = [
    'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n',
    "ID=debian\r\nVERSION_ID=12\r\n",
    "ID=arch\n",
    "ID='alpine'\nVERSION_ID='3.20.3'\n",
    '  ID="fedora"  \n VERSION_ID=41\n',
    'NAME="Something"\n',
    "id=lower\nID_LIKE=debian\n",
    "ID=\nVERSION_ID=1\n",
    "",
]

CI_ENVS = [
    {"GITHUB_ACTIONS": "true", "ImageOS": "ubuntu24", "ImageVersion": "20251012.1.0"},
    {"GITHUB_ACTIONS": "true", "ImageOS": "ubuntu24"},
    {"GITHUB_ACTIONS": "1"},
    {"GITLAB_CI": "true"}, {"CIRCLECI": "true"}, {"BUILDKITE": "true"}, {"JENKINS_URL": "x"}, {"TF_BUILD": "True"},
    {"CI": "true"}, {"CI": "false"}, {"CI": "0"}, {"CI": ""}, {"GITLAB_CI": ""}, {},
]

RENDER_PROBES = [
    {"viewport": {"width": 1280, "height": 720}, "deviceScaleFactor": 2, "colorScheme": "dark", "reducedMotion": "reduce",
     "locale": "en-US", "timezone": "UTC", "userAgent": "UA"},
    {"viewport": {"width": "1280", "height": 720}, "deviceScaleFactor": True, "colorScheme": "blue", "locale": "", "timezone": 3},
    {"viewport": {"width": 1.5, "height": 2}, "deviceScaleFactor": 1.25, "userAgent": ""},
    {"extra": 1},
    None, [], "x", 3,
]

HEALTHY = {
    "fonts": {"status": "loaded", "failed": []},
    "stylesheets": {"failed": 0, "urls": []},
    "images": {"broken": 0, "urls": []},
    "resources": {"status": "checked", "failed": {}},
}


def health(**parts):
    return {**HEALTHY, **parts}


HEALTH_BLOCKS = [
    HEALTHY,
    {**HEALTHY, "extra": 1, "fonts": {"status": "loading", "failed": [{"family": "Fancy", "weight": "700", "style": "italic", "x": 1}]}},
    health(stylesheets={"failed": 2.0, "urls": ["a.css"]}),
    health(stylesheets={"failed": 1, "urls": ["x" * 200]}),
    health(stylesheets={"failed": 1, "urls": ["x" * 201]}),
    health(stylesheets={"failed": 1, "urls": ["\U0001F600" * 100]}),  # 200 UTF-16 units
    health(stylesheets={"failed": 1, "urls": ["\U0001F600" * 101]}),
    health(images={"broken": 25, "urls": [f"example.com/{i}.png" for i in range(25)]}),
    health(images={"broken": True, "urls": []}),
    health(images={"broken": -1, "urls": []}),
    health(images={"broken": 1.5, "urls": []}),
    health(resources={"status": "checked", "failed": {"font": {"count": 1, "entries": [{"url": "f.woff2", "status": 404}]},
                                                      "css": {"count": 1, "entries": [{"url": "a.css", "status": 0, "error": "net::ERR_FAILED"}]}}}),
    health(resources={"status": "checked", "failed": {"css": {"count": 1, "entries": [{"url": "a.css", "status": 0, "error": None}]}}}),
    health(resources={"status": "checked", "failed": {"video": {"count": 1, "entries": []}}}),
    health(resources={"status": "unavailable", "failed": []}),
    health(fonts={"status": "loaded", "failed": [{"family": "F", "weight": 400, "style": "normal"}]}),
    {**HEALTHY, "fonts": None},
    None, [], "healthy",
]


def test_browser_from_user_agent():
    same(run_js("browserFromUserAgent", [[ua] for ua in USER_AGENTS]), [browser_from_user_agent(ua) for ua in USER_AGENTS])


def test_browser_from_capabilities():
    same(run_js("browserFromCapabilities", [[c] for c in CAPABILITIES]), [browser_from_capabilities(c) for c in CAPABILITIES])


def test_distro_from_os_release():
    same(run_js("distroFromOsRelease", [[t] for t in OS_RELEASES]), [distro_from_os_release(t) for t in OS_RELEASES])


def test_detect_ci():
    same(run_js("detectCi", [[e] for e in CI_ENVS]), [detect_ci(e) for e in CI_ENVS])


def test_parse_render_probe():
    same(run_js("parseRenderProbe", [[r] for r in RENDER_PROBES]), [parse_render_probe(r) for r in RENDER_PROBES])


def test_parse_health():
    same(run_js("parseHealth", [[h] for h in HEALTH_BLOCKS]), [parse_health(h) for h in HEALTH_BLOCKS])


def test_build_capture_environment():
    host = {"os": {"platform": "linux", "release": "6.8.0", "arch": "x64", "distro": "ubuntu 24.04"},
            "ci": {"provider": "github-actions", "runnerImage": "ubuntu24/1"}, "container": True, "label": "img"}
    parts = [
        {"host": host, "browser": {"name": "chromium", "version": None},
         "adapter": {"name": "testivai", "version": "0.3.0", "captureMethod": "full-page:cdp"}},
        {"host": host, "browser": {"name": "chromium", "version": "1", "channel": "chrome", "headless": True},
         "adapter": {"name": "testivai", "version": "0.3.0", "captureMethod": "full-page:cdp"},
         "framework": {"name": "selenium", "version": None, "language": "python", "runner": "pytest"},
         "driver": {"name": "chromedriver", "version": "1"},
         "render": {"viewport": {"width": 1, "height": 2}, "locale": "en"}, "project": "mobile"},
        {"host": {"os": {"platform": "darwin", "release": "24", "arch": "arm64"}}, "browser": {"name": "webkit", "version": "26"},
         "adapter": {"name": "testivai", "version": "0.3.0", "captureMethod": "viewport:webdriver"}, "render": {}, "project": ""},
    ]
    same(run_js("buildCaptureEnvironment", [[p] for p in parts]), [build_capture_environment(EnvironmentParts(**p)) for p in parts])


def test_this_machine_reads_the_same_in_both_languages(monkeypatch):
    # The spelling of platform, release and arch is what the two sides most
    # easily disagree on (x86_64 / x64), and what the compare reads as drift.
    monkeypatch.setenv("TESTIVAI_ENV_LABEL", "parity")
    js_host = run_js("collectHostEnvironment", [[]], env=dict(os.environ))[0]
    same([js_host], [collect_host_environment()])
