# TestivAI OSS Documentation

The documentation for `@testivai/witness` and the framework adapters. Everything here is **local-first**: no account, no API key, no upload — capture, diff, report, approve, all on disk.

## Start here

- **[Getting Started](./intro.md)** — install + first capture, 5 minutes
- **[How It Works](./how-it-works.md)** — high-level architecture
- **[vs. Playwright's built-in screenshots](./vs-playwright-builtin.md)** — what `toHaveScreenshot()` covers, and when TestivAI is worth the dependency
- **[MCP server](./mcp.md)** — visual results for AI agents, with a real `explain_snapshot` output
- **[Maintenance & roadmap](./maintenance.md)** — who builds this, release cadence, and what happens if it stops
- **[Ruby (Capybara / RSpec)](./frameworks/ruby.md)** — native adapter, no sidecar
- **[vs. rolling your own (Selenium)](./vs-selenium-tooling.md)** — Selenium ships no visual comparison; what you'd otherwise build yourself
- **[Comparison: masks, regions, tolerances](./comparison.md)** — excluding dynamic areas, region-level diffs
- **[Philosophy](./philosophy.md)** — local-first detection, bring-your-own-model AI

## Frameworks (OSS adapters)

Pick the framework you use:

- **[Playwright](./frameworks/playwright.md)** — `@testivai/witness-playwright`
- **[Selenium](./frameworks/selenium.md)** — native adapters for JS, Python, and Java
- **[WebdriverIO](./frameworks/webdriverio.md)** — `@testivai/witness-webdriverio` (local mode)
- **[Python](./frameworks/python.md)** — `testivai` on PyPI (playwright-python + Selenium)
- **[Java](./frameworks/java.md)** — `ai.testiv:testivai` (playwright-java + Selenium, experimental)
- Other frameworks (Cypress, Puppeteer, …) — planned after Playwright adoption; the [`testivai run` sidecar](./sidecar-testivai-run.md) works today (experimental)

## CLI Reference

- **[`testivai init`](./cli/init.md)** — set up local mode in your project
- **[`testivai run`](./cli/run.md)** — experimental sidecar for non-adapter frameworks (see also [sidecar caveats](./sidecar-testivai-run.md))
- **[`testivai witness`](./cli/capture.md)** — manual single-snapshot capture
- **[`testivai report`](./cli/report.md)** — compare + report, `--json`, CI exit codes
- **[`testivai approve`](./cli/approve.md)** — promote captures to baselines, `--all`, `--undo`

## Reference

- **[`results.json` schema + on-disk layout (Extension API)](./extension-api.md)** — the contract for community adapters and third-party reporters
- **[GitHub Action](./github-action.md)** — `testivai/testivai-oss@v1` for PR comments + commit status
- **[`testivai run` experimental sidecar](./sidecar-testivai-run.md)** — what it is, why it's labeled experimental, when to use it anyway

## Guides

- **[Python (playwright-python)](./frameworks/python.md)**
- **[Java (playwright-java)](./frameworks/java.md)**
- **[Mobile web](./guides/mobile-web.md)** — one Playwright project per device profile
- **[AI agents & code assistants](./guides/ai-agents.md)**
- **[Vibe-coded apps (Lovable, Bolt, v0)](./guides/vibe-coded-apps.md)**
- **[CI/CD](./guides/ci-cd.md)**
- **[Stable Baselines](./guides/stable-baselines.md)**
- **[Headless](./guides/headless.md)**
- **[Docker](./guides/docker.md)**
- **[Troubleshooting](./guides/troubleshooting.md)**

## Source of truth

The canonical OSS docs live in this repo at [`/docs`](https://github.com/testivai/testivai-oss/tree/main/docs). They sync to the public docs site automatically on each release. To propose a change, open a PR here. Issues: [GitHub Issues](https://github.com/testivai/testivai-oss/issues).
