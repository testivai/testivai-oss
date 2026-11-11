"""
Capture provenance: where a capture came from.

The `environment` block the JS adapters record in the capture's metadata.json
(packages/witness/src/capture/environment.ts, docs/extension-api.md), built
the same way here, field for field. The compare reads a Python capture
against a baseline any adapter may have taken, so every value is spelled as
the JS side spells it (Node's `x64`, never `x86_64`): a difference in
spelling would read as rendering drift. Nothing is guessed: what cannot be
observed is left out, or None for a browser version.
"""

from __future__ import annotations

import math
import os
import platform as _platform
import re
import sys
from dataclasses import dataclass, field
from importlib import metadata as _metadata
from typing import Any, Callable, Optional

from ._version import __version__

ADAPTER_NAME = "testivai"

#: How the screenshot was taken, as `<extent>:<mechanism>` (CAPTURE_METHODS in environment.ts).
CAPTURE_METHODS = {
    "CDP_FULL_PAGE": "full-page:cdp",
    "PLAYWRIGHT_FULL_PAGE": "full-page:playwright",
    "FIREFOX_FULL_PAGE": "full-page:firefox",
    "WEBDRIVER_VIEWPORT": "viewport:webdriver",
}

# JavaScript's String.prototype.trim() whitespace: Python's strip() also
# removes \x1c-\x1f and \x85, and keeps ﻿.
_JS_WHITESPACE = "\t\n\v\f\r                  　﻿"


def _js_trim(text: str) -> str:
    return text.strip(_JS_WHITESPACE)


# ── Host ────────────────────────────────────────────────────────────────────

# platform.machine() → Node's process.arch.
_NODE_ARCH = {
    "x86_64": "x64", "amd64": "x64", "x64": "x64",
    "aarch64": "arm64", "arm64": "arm64",
    "i386": "ia32", "i486": "ia32", "i586": "ia32", "i686": "ia32", "x86": "ia32",
    "armv6l": "arm", "armv7l": "arm", "armv7": "arm", "arm": "arm",
    "ppc64le": "ppc64", "ppc64": "ppc64", "ppc": "ppc",
    "s390x": "s390x", "s390": "s390",
    "riscv64": "riscv64", "loongarch64": "loong64", "mips": "mips", "mipsel": "mipsel",
}

# sys.platform prefix → Node's process.platform.
_NODE_PLATFORMS = ("linux", "darwin", "win32", "cygwin", "freebsd", "openbsd", "netbsd", "sunos", "aix", "android")


def node_arch(machine: str) -> str:
    """The architecture as Node's process.arch names it."""
    key = (machine or "").lower()
    return _NODE_ARCH.get(key, key)


def node_platform(sys_platform: str) -> str:
    """The OS as Node's process.platform names it ("freebsd14" is "freebsd")."""
    for name in _NODE_PLATFORMS:
        if sys_platform.startswith(name):
            return name
    return re.sub(r"\d+$", "", sys_platform)


def os_release(sys_platform: str, *, release: str, version: str) -> str:
    """As Node's os.release(): the OS version on Windows ("10.0.22631"), the kernel elsewhere (uname -r)."""
    return version if sys_platform.startswith("win") else release


def distro_from_os_release(text: str) -> Optional[str]:
    """The distro from /etc/os-release as `<ID> <VERSION_ID>` ("ubuntu 24.04"; "arch" without a version)."""
    fields = {}
    for line in re.split(r"\r?\n", text):
        match = re.fullmatch(r"([A-Z_]+)=([^\n\r  ]*)", _js_trim(line))
        if match:
            fields[match.group(1)] = re.sub(r"^[\"']|[\"']\Z", "", match.group(2))
    if not fields.get("ID"):
        return None
    return f"{fields['ID']} {fields['VERSION_ID']}" if fields.get("VERSION_ID") else fields["ID"]


_CI_FLAGS = (("GITLAB_CI", "gitlab"), ("CIRCLECI", "circleci"), ("BUILDKITE", "buildkite"),
             ("JENKINS_URL", "jenkins"), ("TF_BUILD", "azure-pipelines"))


def detect_ci(env: Any) -> Optional[dict]:
    """The CI provider, and the runner image where the provider names one."""
    if env.get("GITHUB_ACTIONS") == "true":
        image = f"{env['ImageOS']}/{env['ImageVersion']}" if env.get("ImageOS") and env.get("ImageVersion") else None
        return {"provider": "github-actions", "runnerImage": image} if image else {"provider": "github-actions"}
    for flag, provider in _CI_FLAGS:
        if env.get(flag):
            return {"provider": provider}
    if env.get("CI") and env.get("CI") not in ("false", "0"):
        return {"provider": "ci"}
    return None


def _read_text(path: str) -> Optional[str]:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return None


@dataclass
class HostSources:
    """Where collect_host_environment reads from; every source can be replaced in tests."""

    env: Any = field(default_factory=lambda: dict(os.environ))
    platform: str = field(default_factory=lambda: node_platform(sys.platform))
    release: str = field(default_factory=lambda: os_release(sys.platform, release=_platform.release(), version=_platform.version()))
    arch: str = field(default_factory=lambda: node_arch(_platform.machine()))
    read_file: Callable[[str], Optional[str]] = _read_text
    exists: Callable[[str], bool] = os.path.exists


def _safely(fn: Callable[[], Any], fallback: Any) -> Any:
    try:
        return fn()
    except Exception:
        return fallback


def _distro(sources: HostSources) -> Optional[str]:
    text = _safely(lambda: sources.read_file("/etc/os-release"), None)
    return distro_from_os_release(text) if text else None


def _os_block(s: HostSources) -> dict:
    """Platform, release and arch; on Linux the distro too, which decides the fonts."""
    block = {"platform": s.platform, "release": s.release, "arch": s.arch}
    distro = _distro(s) if s.platform == "linux" else None
    if distro:
        block["distro"] = distro
    return block


def _host_context(s: HostSources) -> dict:
    """CI, a container and TESTIVAI_ENV_LABEL, each only when present."""
    context: dict = {}
    ci = detect_ci(s.env)
    if ci:
        context["ci"] = ci
    if _safely(lambda: s.exists("/.dockerenv") or s.exists("/run/.containerenv"), False):
        context["container"] = True
    label = _js_trim(s.env.get("TESTIVAI_ENV_LABEL") or "")
    if label:
        context["label"] = label
    return context


def collect_host_environment(sources: Optional[HostSources] = None) -> dict:
    """The machine-level part of the block, the same for every capture of a run. Never raises."""
    s = sources or HostSources()
    return {"os": _os_block(s), **_host_context(s)}


# ── Browser ─────────────────────────────────────────────────────────────────

# ASCII, as in JavaScript: \b and \d there know nothing of other scripts.
_EDGE = re.compile(r"\bEdg/([0-9.]+)", re.ASCII)
_CHROME = re.compile(r"\b(HeadlessChrome|Chrome|Chromium)/([0-9.]+)", re.ASCII)
_FIREFOX = re.compile(r"\bFirefox/([0-9.]+)", re.ASCII)
_SAFARI_VERSION = re.compile(r"\bVersion/([0-9.]+)", re.ASCII)
_SAFARI = re.compile(r"\bSafari/", re.ASCII)


def _chromium_from_user_agent(ua: str) -> Optional[dict]:
    chrome = _CHROME.search(ua)
    if not chrome:
        return None
    browser = {"name": "chromium", "version": chrome.group(2)}
    if chrome.group(1) == "HeadlessChrome":
        browser["headless"] = True
    if _EDGE.search(ua):
        browser["channel"] = "msedge"
    return browser


def browser_from_user_agent(ua: Optional[str]) -> Optional[dict]:
    """The engine and its version from a user agent (Edge is chromium with channel msedge)."""
    if not ua:
        return None
    chromium = _chromium_from_user_agent(ua)
    if chromium:
        return chromium
    firefox = _FIREFOX.search(ua)
    if firefox:
        return {"name": "firefox", "version": firefox.group(1)}
    safari = _SAFARI_VERSION.search(ua)
    # Sliced, as the JS side does: \b at the slice's start sees no character before it.
    if safari and _SAFARI.search(ua[safari.end():]):
        return {"name": "webkit", "version": safari.group(1)}
    return None


# WebDriver browserName values: the engine family, its branded channel and its driver.
_WEBDRIVER_BROWSERS = {
    "chrome": {"name": "chromium", "channel": "chrome", "driver": "chromedriver"},
    "chrome-headless-shell": {"name": "chromium", "channel": "chrome-headless-shell", "driver": "chromedriver"},
    "chromium": {"name": "chromium", "driver": "chromedriver"},
    "microsoftedge": {"name": "chromium", "channel": "msedge", "driver": "msedgedriver"},
    "msedge": {"name": "chromium", "channel": "msedge", "driver": "msedgedriver"},
    "firefox": {"name": "firefox", "driver": "geckodriver"},
    "safari": {"name": "webkit", "channel": "safari"},
}
_HEADLESS_ARG = re.compile(r"-{1,2}headless(=|\Z)")


def _first_token(value: Any) -> Optional[str]:
    """ "141.0.7390.37 (hash-refs/…)" → "141.0.7390.37"."""
    if not isinstance(value, str) or not _js_trim(value):
        return None
    return re.split(r"\s+", _js_trim(value))[0]


def _first_present(caps: dict, *keys: str) -> Any:
    """The first value that is not missing (JavaScript's `??`)."""
    for key in keys:
        if caps.get(key) is not None:
            return caps[key]
    return None


def _headless(caps: dict) -> Optional[bool]:
    """From the browser's own launch arguments, and only when they are there to say it."""
    options = _first_present(caps, "goog:chromeOptions", "ms:edgeOptions", "moz:firefoxOptions")
    args = options.get("args") if isinstance(options, dict) else None
    if not isinstance(args, list):
        return None
    return any(isinstance(a, str) and _HEADLESS_ARG.match(a) for a in args)


def _sub(caps: dict, key: str, field_name: str) -> Any:
    value = caps.get(key)
    return value.get(field_name) if isinstance(value, dict) else None


def _driver_version(caps: dict, driver: Optional[str]) -> Optional[str]:
    if driver == "chromedriver":
        return _first_token(_sub(caps, "chrome", "chromedriverVersion"))
    if driver == "msedgedriver":
        return _first_token(_sub(caps, "msedge", "msedgedriverVersion"))
    if driver == "geckodriver":
        return _first_token(caps.get("moz:geckodriverVersion"))
    return None


def browser_from_capabilities(caps: Any) -> Optional[dict]:
    """
    The browser (and the WebDriver binary) from W3C capabilities, as Selenium's
    `driver.capabilities` gives them: {"browser": …, "driver": …}, or None
    without a browser name.
    """
    if not isinstance(caps, dict):
        return None
    raw = caps.get("browserName")
    if not isinstance(raw, str) or not raw:
        return None
    known = _WEBDRIVER_BROWSERS.get(raw.lower(), {})
    version = _first_present(caps, "browserVersion", "version")
    browser: dict = {"name": known.get("name", raw.lower()), "version": version if isinstance(version, str) and version else None}
    if known.get("channel"):
        browser["channel"] = known["channel"]
    headless = _headless(caps)
    if headless is not None:
        browser["headless"] = headless
    driver_version = _driver_version(caps, known.get("driver"))
    if driver_version:
        return {"browser": browser, "driver": {"name": known["driver"], "version": driver_version}}
    return {"browser": browser}


# ── Render probe ────────────────────────────────────────────────────────────


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_text(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def _viewport(raw: dict) -> Optional[dict]:
    vp = raw.get("viewport")
    if isinstance(vp, dict) and _is_number(vp.get("width")) and _is_number(vp.get("height")):
        return {"width": vp["width"], "height": vp["height"]}
    return None


_RENDER_CHOICES = (("colorScheme", ("light", "dark")), ("reducedMotion", ("reduce", "no-preference")))


def parse_render_probe(raw: Any) -> Optional[dict]:
    """Validate RENDER_PROBE_EXPRESSION's result: {"render": …, "userAgent": …}. Mistyped fields are dropped."""
    if not isinstance(raw, dict):
        return None
    render: dict = {}
    viewport = _viewport(raw)
    if viewport:
        render["viewport"] = viewport
    if _is_number(raw.get("deviceScaleFactor")):
        render["deviceScaleFactor"] = raw["deviceScaleFactor"]
    for key, allowed in _RENDER_CHOICES:
        if raw.get(key) in allowed:
            render[key] = raw[key]
    for key in ("locale", "timezone"):
        if _is_text(raw.get(key)):
            render[key] = raw[key]
    return {"render": render, "userAgent": raw["userAgent"]} if _is_text(raw.get("userAgent")) else {"render": render}


# ── Assembly ────────────────────────────────────────────────────────────────


@dataclass
class EnvironmentParts:
    """What one adapter observed (CaptureEnvironmentParts in environment.ts)."""

    host: dict
    browser: dict
    adapter: dict
    framework: Optional[dict] = None
    driver: Optional[dict] = None
    render: Optional[dict] = None
    project: Optional[str] = None


def build_capture_environment(parts: EnvironmentParts) -> dict:
    """Assemble the block in the documented order, leaving out what was not observed."""
    host = parts.host
    env: dict = {"os": dict(host["os"]), "browser": dict(parts.browser)}
    if parts.framework:
        env["framework"] = dict(parts.framework)
    env["adapter"] = dict(parts.adapter)
    if parts.driver:
        env["driver"] = dict(parts.driver)
    if parts.render:
        env["render"] = dict(parts.render)
    if host.get("ci"):
        env["ci"] = dict(host["ci"])
    if host.get("container"):
        env["container"] = True
    if host.get("label"):
        env["label"] = host["label"]
    if parts.project:
        env["project"] = parts.project
    return env


def package_version(name: str) -> Optional[str]:
    """The installed version of a distribution, or None."""
    try:
        return _metadata.version(name)
    except _metadata.PackageNotFoundError:
        return None


def python_framework(name: str) -> dict:
    """The test framework block: Playwright or Selenium for Python, and pytest when a test is running."""
    framework = {"name": name, "version": package_version(name), "language": "python"}
    if os.environ.get("PYTEST_CURRENT_TEST"):
        framework["runner"] = "pytest"
    return framework


def adapter_block(capture_method: str) -> dict:
    return {"name": ADAPTER_NAME, "version": __version__, "captureMethod": capture_method}


def webdriver_environment(capabilities: Any, probe: Any, adapter: dict, framework: dict, *,
                          host: Optional[dict] = None, project: Optional[str] = None) -> Optional[dict]:
    """
    The block for the Selenium adapter: the browser and driver from the
    capabilities (the user agent when they say nothing), the render settings
    from the probe. None when neither names the browser.
    """
    probed = parse_render_probe(probe) or {}
    from_caps = browser_from_capabilities(capabilities) or {}
    browser = from_caps.get("browser") or browser_from_user_agent(probed.get("userAgent"))
    if not browser:
        return None
    return build_capture_environment(EnvironmentParts(
        host=host or collect_host_environment(), browser=browser, framework=dict(framework), adapter=adapter,
        driver=from_caps.get("driver"), render=probed.get("render"), project=project,
    ))


def _playwright_browser(name: Optional[str], version: Optional[str], from_ua: dict) -> dict:
    """Playwright's own answer first, then the user agent; Playwright's default engine last."""
    browser = {
        "name": name or from_ua.get("name") or "chromium",
        "version": version if version is not None else from_ua.get("version"),
    }
    if from_ua.get("headless"):
        browser["headless"] = True
    return browser


def playwright_environment(browser_name: Optional[str], browser_version: Optional[str], probe: Any,
                           capture_method: str, project: Optional[str], *, host: Optional[dict] = None) -> dict:
    """
    The block for the playwright-python adapter. The engine and version come
    from Playwright's Browser (a persistent context has none: then the user
    agent), headless from the user agent (Playwright does not say), the
    render settings from the probe.
    """
    probed = parse_render_probe(probe) or {}
    from_ua = browser_from_user_agent(probed.get("userAgent")) or {}
    return build_capture_environment(EnvironmentParts(
        host=host or collect_host_environment(),
        browser=_playwright_browser(browser_name, browser_version, from_ua),
        framework=python_framework("playwright"),
        adapter=adapter_block(capture_method),
        render=probed.get("render"),
        project=project,
    ))
