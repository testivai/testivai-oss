---
sidebar_position: 2
title: Docker
---

# Docker

Font rasterization differs between macOS, Linux, and Windows, so a baseline
approved on one machine can flag forever on another (see
[cross-platform baselines](./stable-baselines.md#cross-platform-baselines)).
Running your visual tests inside one Docker image, on your laptop and in CI,
removes that variable: every capture comes from the same browser build, the
same fonts, and the same OS.

## Playwright: use the official image

Run the suite in Microsoft's Playwright image. Its tag must match the
`@playwright/test` version in your lockfile, or Playwright won't find the
browser builds it expects:

```bash
PW_VERSION=$(node -p "require('@playwright/test/package.json').version")

docker run --rm --ipc=host \
  -v "$PWD":/work -w /work \
  mcr.microsoft.com/playwright:v${PW_VERSION}-noble \
  sh -c "npm ci && npx playwright test"
```

- `--ipc=host` gives Chromium enough shared memory. Docker's default
  `/dev/shm` is 64 MB, which crashes Chromium on large pages. `--shm-size=1gb`
  works too.
- The report lands in `visual-report/` on your machine, because the project
  directory is mounted.
- Use the same image in CI. The GitLab and CircleCI examples in the
  [CI/CD guide](./ci-cd.md#other-ci-providers) already do; on GitHub Actions,
  set `container: mcr.microsoft.com/playwright:v<version>-noble` on the job.

## Approve from the same image

A baseline is only stable if it was captured where it will be compared.
Approve inside the container too:

```bash
docker run --rm --ipc=host -v "$PWD":/work -w /work \
  mcr.microsoft.com/playwright:v${PW_VERSION}-noble \
  npx testivai approve --all

git add .testivai/baselines/
```

Or let CI own the baselines and approve with a `/testivai approve` comment on
the pull request ([GitHub Action](../github-action.md)). Either way, the
capture that becomes the baseline comes from the image that compares against it.

## No test suite: `testivai witness <url>` in a container

[Standalone mode](../cli/capture.md) launches its own headless Chrome, so the
image needs a Chrome or Chromium binary. TestivAI looks for one in this order:

1. `TESTIVAI_CHROME_PATH`
2. standard install locations
3. `google-chrome`, `google-chrome-stable`, `chromium-browser` or `chromium`
   on `PATH`

On a Debian-based Node image, the distribution's Chromium is on `PATH` once
installed:

```dockerfile title="Dockerfile"
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
```

```bash
docker build -t visual .
docker run --rm -v "$PWD":/work visual \
  npx testivai witness http://host.docker.internal:3000 --pages "/,/pricing"
```

The app under test runs on your machine, not in the container, so
`localhost` inside the container is the wrong host. Use
`host.docker.internal` (Docker Desktop; on Linux add
`--add-host=host.docker.internal:host-gateway`), or `--network host` on Linux,
or run the app in the same container or Compose network.

## Running as root

Chrome refuses to start as root while its sandbox is enabled, and root is the
default user in most images. TestivAI detects root and launches Chrome with
`--no-sandbox` and `--disable-dev-shm-usage`, so a standalone run works
without extra flags.

| Variable | Effect |
|---|---|
| `TESTIVAI_CHROME_NO_SANDBOX=1` | Force `--no-sandbox` on, for a non-root container whose seccomp profile still blocks the sandbox |
| `TESTIVAI_CHROME_NO_SANDBOX=0` | Force it off, even as root (Chrome then exits at startup) |
| `TESTIVAI_CHROME_PATH` | Use this Chrome or Chromium binary |
| `TESTIVAI_CHROME_STARTUP_TIMEOUT_MS` | Wait longer than the default 30 s for Chrome to start on a slow runner |

If Chrome exits instead of starting, the error quotes its exit code and the
end of its stderr, and says which of these variables to set.

These variables apply to `testivai witness <url>`. Inside your Playwright,
WebdriverIO, or Selenium tests, the framework launches the browser, so its own
launch options apply.

## Fonts

Whatever fonts the image has are the fonts your baselines use. Install the
fonts your site needs into the image (or serve them as web fonts), and change
the image deliberately: a new base image or font package can shift text
rendering, which shows up as a diff on every snapshot. Approve those as one
reviewed change, not spread over several pull requests.
