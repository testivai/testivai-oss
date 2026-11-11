"""
Capture provenance for the Python adapters: the `environment` block, as
packages/witness/src/capture/environment.ts builds it for the JS adapters.

The values must be spelled exactly as the JS adapters spell them, because the
compare reads a Python capture against a baseline any adapter may have taken:
`x86_64` where Node says `x64` would read as rendering drift. The cases below
are the JS suite's; test_parity_with_js.py runs both sides on the same input.
"""

import pytest

from testivai._environment import (
    CAPTURE_METHODS,
    EnvironmentParts,
    HostSources,
    browser_from_capabilities,
    browser_from_user_agent,
    build_capture_environment,
    collect_host_environment,
    detect_ci,
    distro_from_os_release,
    node_arch,
    node_platform,
    os_release,
    parse_render_probe,
    playwright_environment,
    webdriver_environment,
)

HOST = {"os": {"platform": "linux", "release": "6.8.0", "arch": "x64", "distro": "ubuntu 24.04"}}


class TestHostNames:
    @pytest.mark.parametrize(
        "machine, arch",
        [("x86_64", "x64"), ("AMD64", "x64"), ("amd64", "x64"), ("aarch64", "arm64"), ("arm64", "arm64"),
         ("ARM64", "arm64"), ("i686", "ia32"), ("i386", "ia32"), ("x86", "ia32"), ("armv7l", "arm"),
         ("ppc64le", "ppc64"), ("s390x", "s390x"), ("riscv64", "riscv64"), ("loongarch64", "loong64")],
    )
    def test_arch_is_spelled_as_node_spells_it(self, machine, arch):
        assert node_arch(machine) == arch

    @pytest.mark.parametrize(
        "sys_platform, platform",
        [("linux", "linux"), ("darwin", "darwin"), ("win32", "win32"), ("cygwin", "cygwin"),
         ("freebsd14", "freebsd"), ("openbsd7", "openbsd"), ("netbsd10", "netbsd"), ("sunos5", "sunos"), ("aix", "aix")],
    )
    def test_platform_is_spelled_as_node_spells_it(self, sys_platform, platform):
        assert node_platform(sys_platform) == platform

    def test_release_is_the_os_version_on_windows_and_the_kernel_elsewhere(self):
        # Node's os.release(): "10.0.22631" on Windows, uname -r on Linux and macOS
        assert os_release("win32", release="11", version="10.0.22631") == "10.0.22631"
        assert os_release("linux", release="6.8.0-1017-azure", version="#1 SMP") == "6.8.0-1017-azure"
        assert os_release("darwin", release="24.6.0", version="Darwin Kernel") == "24.6.0"


class TestDistro:
    def test_reads_id_and_version_id(self):
        text = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n'
        assert distro_from_os_release(text) == "ubuntu 24.04"

    def test_unquoted_values_and_a_rolling_distro_without_version_id(self):
        assert distro_from_os_release("ID=debian\nVERSION_ID=12\n") == "debian 12"
        assert distro_from_os_release("ID=arch\n") == "arch"

    def test_none_without_an_id(self):
        assert distro_from_os_release('NAME="Something"\n') is None


class TestCi:
    def test_github_actions_with_the_runner_image(self):
        env = {"GITHUB_ACTIONS": "true", "ImageOS": "ubuntu24", "ImageVersion": "20251012.1.0"}
        assert detect_ci(env) == {"provider": "github-actions", "runnerImage": "ubuntu24/20251012.1.0"}
        assert detect_ci({"GITHUB_ACTIONS": "true"}) == {"provider": "github-actions"}

    @pytest.mark.parametrize(
        "env, provider",
        [({"GITLAB_CI": "true"}, "gitlab"), ({"CIRCLECI": "true"}, "circleci"), ({"BUILDKITE": "true"}, "buildkite"),
         ({"JENKINS_URL": "http://ci"}, "jenkins"), ({"TF_BUILD": "True"}, "azure-pipelines"), ({"CI": "true"}, "ci")],
    )
    def test_other_providers_and_a_generic_ci(self, env, provider):
        assert detect_ci(env) == {"provider": provider}

    @pytest.mark.parametrize("env", [{}, {"CI": "false"}, {"CI": "0"}, {"CI": ""}])
    def test_none_outside_ci(self, env):
        assert detect_ci(env) is None


def sources(**kw):
    defaults = dict(
        env={}, platform="linux", release="6.8.0", arch="x64",
        read_file=lambda p: "ID=ubuntu\nVERSION_ID=24.04\n" if p == "/etc/os-release" else None,
        exists=lambda p: False,
    )
    defaults.update(kw)
    return HostSources(**defaults)


class TestCollectHost:
    def test_the_os_with_the_distro_on_linux(self):
        assert collect_host_environment(sources()) == HOST

    def test_no_distro_off_linux(self):
        host = collect_host_environment(sources(platform="darwin", release="24.6.0", arch="arm64"))
        assert host == {"os": {"platform": "darwin", "release": "24.6.0", "arch": "arm64"}}

    def test_ci_container_and_label_when_present(self):
        host = collect_host_environment(sources(
            env={"GITHUB_ACTIONS": "true", "TESTIVAI_ENV_LABEL": "  mcr.microsoft.com/playwright:v1.64.1-noble "},
            exists=lambda p: p == "/run/.containerenv",
        ))
        assert host == {**HOST, "ci": {"provider": "github-actions"}, "container": True,
                        "label": "mcr.microsoft.com/playwright:v1.64.1-noble"}

    def test_an_empty_label_is_no_label(self):
        assert "label" not in collect_host_environment(sources(env={"TESTIVAI_ENV_LABEL": "   "}))

    def test_never_throws_when_a_source_does(self):
        def boom(_):
            raise OSError("nope")

        assert collect_host_environment(sources(read_file=boom, exists=boom))["os"] == {
            "platform": "linux", "release": "6.8.0", "arch": "x64",
        }

    def test_defaults_to_this_machine(self):
        host = collect_host_environment()
        assert host["os"]["platform"] in ("linux", "darwin", "win32", "freebsd", "openbsd", "netbsd", "sunos", "aix", "cygwin")
        assert host["os"]["arch"] and host["os"]["release"] is not None


class TestBrowserFromUserAgent:
    @pytest.mark.parametrize(
        "ua, browser",
        [
            ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36",
             {"name": "chromium", "version": "141.0.7390.37", "headless": True}),
            ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.37 Safari/537.36",
             {"name": "chromium", "version": "141.0.7390.37"}),
            ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57",
             {"name": "chromium", "version": "141.0.0.0", "channel": "msedge"}),
            ("Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0", {"name": "firefox", "version": "143.0"}),
            ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
             {"name": "webkit", "version": "26.0"}),
        ],
    )
    def test_reads_the_engine_and_version(self, ua, browser):
        assert browser_from_user_agent(ua) == browser

    @pytest.mark.parametrize("ua", ["curl/8.5.0", "", "SomeTool Version/2.1", None])
    def test_none_for_anything_else(self, ua):
        assert browser_from_user_agent(ua) is None


class TestBrowserFromCapabilities:
    def test_chrome_with_headless_from_its_args_and_chromedriver(self):
        caps = {
            "browserName": "chrome",
            "browserVersion": "141.0.7390.37",
            "goog:chromeOptions": {"args": ["--headless=new", "--no-sandbox"]},
            "chrome": {"chromedriverVersion": "141.0.7390.37 (2b1b84a5-refs/branch-heads/7390@{#1})"},
        }
        assert browser_from_capabilities(caps) == {
            "browser": {"name": "chromium", "version": "141.0.7390.37", "channel": "chrome", "headless": True},
            "driver": {"name": "chromedriver", "version": "141.0.7390.37"},
        }

    def test_edge_firefox_and_safari(self):
        assert browser_from_capabilities(
            {"browserName": "MicrosoftEdge", "browserVersion": "141.0.3537.57", "msedge": {"msedgedriverVersion": "141.0.3537.57 (abc)"}}
        ) == {"browser": {"name": "chromium", "version": "141.0.3537.57", "channel": "msedge"},
              "driver": {"name": "msedgedriver", "version": "141.0.3537.57"}}
        assert browser_from_capabilities(
            {"browserName": "firefox", "browserVersion": "143.0", "moz:firefoxOptions": {"args": ["-headless"]}, "moz:geckodriverVersion": "0.36.0"}
        ) == {"browser": {"name": "firefox", "version": "143.0", "headless": True}, "driver": {"name": "geckodriver", "version": "0.36.0"}}
        assert browser_from_capabilities({"browserName": "Safari", "browserVersion": "26.0"}) == {
            "browser": {"name": "webkit", "version": "26.0", "channel": "safari"},
        }

    def test_headless_false_only_when_the_options_are_there_to_say_so(self):
        assert browser_from_capabilities({"browserName": "chrome", "browserVersion": "1", "goog:chromeOptions": {"args": []}})["browser"]["headless"] is False
        assert "headless" not in browser_from_capabilities({"browserName": "chrome", "browserVersion": "1"})["browser"]

    def test_none_without_a_browser_name_and_an_unknown_browser_keeps_its_name(self):
        assert browser_from_capabilities({}) is None
        assert browser_from_capabilities(None) is None
        assert browser_from_capabilities({"browserName": "Servo", "browserVersion": "0.1"}) == {"browser": {"name": "servo", "version": "0.1"}}

    def test_an_old_style_version_capability_and_a_missing_version(self):
        assert browser_from_capabilities({"browserName": "chrome", "version": "99.0"})["browser"]["version"] == "99.0"
        assert browser_from_capabilities({"browserName": "chrome"})["browser"]["version"] is None


class TestRenderProbe:
    def test_keeps_what_is_well_typed(self):
        raw = {"viewport": {"width": 1280, "height": 720}, "deviceScaleFactor": 2, "colorScheme": "dark",
               "reducedMotion": "reduce", "locale": "en-US", "timezone": "UTC", "userAgent": "UA"}
        assert parse_render_probe(raw) == {
            "render": {"viewport": {"width": 1280, "height": 720}, "deviceScaleFactor": 2, "colorScheme": "dark",
                       "reducedMotion": "reduce", "locale": "en-US", "timezone": "UTC"},
            "userAgent": "UA",
        }

    def test_drops_mistyped_fields_and_is_none_for_a_non_object(self):
        raw = {"viewport": {"width": "1280", "height": 720}, "deviceScaleFactor": True, "colorScheme": "blue",
               "reducedMotion": None, "locale": "", "timezone": 3}
        assert parse_render_probe(raw) == {"render": {}}
        assert parse_render_probe(None) is None
        assert parse_render_probe([1]) is None


class TestBuild:
    def test_the_documented_order_and_nothing_an_adapter_did_not_provide(self):
        env = build_capture_environment(EnvironmentParts(
            host=HOST,
            browser={"name": "chromium", "version": None},
            adapter={"name": "testivai", "version": "0.3.0", "captureMethod": CAPTURE_METHODS["PLAYWRIGHT_FULL_PAGE"]},
        ))
        assert env == {"os": HOST["os"], "browser": {"name": "chromium", "version": None},
                       "adapter": {"name": "testivai", "version": "0.3.0", "captureMethod": "full-page:playwright"}}
        assert list(env) == ["os", "browser", "adapter"]

    def test_keeps_framework_driver_render_ci_container_label_and_project(self):
        host = {**HOST, "ci": {"provider": "ci"}, "container": True, "label": "img"}
        env = build_capture_environment(EnvironmentParts(
            host=host,
            browser={"name": "chromium", "version": "1"},
            adapter={"name": "testivai", "version": "0.3.0", "captureMethod": "full-page:cdp"},
            framework={"name": "selenium", "version": "4.52.0", "language": "python"},
            driver={"name": "chromedriver", "version": "1"},
            render={"viewport": {"width": 800, "height": 600}},
            project="mobile",
        ))
        assert list(env) == ["os", "browser", "framework", "adapter", "driver", "render", "ci", "container", "label", "project"]

    def test_an_empty_render_is_left_out(self):
        env = build_capture_environment(EnvironmentParts(
            host=HOST, browser={"name": "chromium", "version": "1"},
            adapter={"name": "testivai", "version": "0.3.0", "captureMethod": "full-page:cdp"}, render={},
        ))
        assert "render" not in env


class TestAdapterBlocks:
    def test_webdriver_reads_the_browser_from_the_capabilities_then_the_user_agent(self):
        probe = {"viewport": {"width": 800, "height": 600}, "userAgent": "Mozilla/5.0 Firefox/143.0"}
        adapter = {"name": "testivai", "version": "0.3.0", "captureMethod": "viewport:webdriver"}
        framework = {"name": "selenium", "version": "4.52.0", "language": "python"}
        from_caps = webdriver_environment({"browserName": "chrome", "browserVersion": "1"}, probe, adapter, framework, host=HOST)
        assert from_caps["browser"] == {"name": "chromium", "version": "1", "channel": "chrome"}
        assert from_caps["render"] == {"viewport": {"width": 800, "height": 600}}
        assert webdriver_environment({}, probe, adapter, framework, host=HOST)["browser"] == {"name": "firefox", "version": "143.0"}

    def test_webdriver_is_none_when_nothing_names_the_browser(self):
        adapter = {"name": "testivai", "version": "0.3.0", "captureMethod": "viewport:webdriver"}
        assert webdriver_environment({}, {"userAgent": "curl/8"}, adapter, {"name": "selenium", "version": None}, host=HOST) is None
        assert webdriver_environment(None, None, adapter, {"name": "selenium", "version": None}, host=HOST) is None

    def test_playwright_names_the_engine_from_playwright_then_the_user_agent_then_chromium(self):
        ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36"
        firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0"
        env = playwright_environment("firefox", "143.0", {"userAgent": firefox}, "full-page:playwright", None, host=HOST)
        assert env["browser"] == {"name": "firefox", "version": "143.0"}
        env = playwright_environment(None, None, {"userAgent": ua}, "full-page:playwright", None, host=HOST)
        assert env["browser"] == {"name": "chromium", "version": "141.0.7390.37", "headless": True}
        env = playwright_environment(None, None, None, "full-page:playwright", "mobile", host=HOST)
        assert env["browser"] == {"name": "chromium", "version": None}
        assert env["project"] == "mobile"
        assert env["framework"]["name"] == "playwright" and env["framework"]["language"] == "python"
        assert env["adapter"]["name"] == "testivai" and env["adapter"]["captureMethod"] == "full-page:playwright"
