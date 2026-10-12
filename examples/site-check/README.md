# Site check: "it's up" is not the same as "it works"

Most uptime monitors ask one question: did the page answer with HTTP 200?
But a page can answer 200 and still be broken. The stylesheet 404s and the
site looks like a 1998 text file. A script throws and the shop renders an empty
white box. The CDN serves its own error page where your font should be.

This folder is a small check that opens your pages in a real Chrome browser
every hour, from GitHub Actions, and fails when a page is **up but broken**.
When it fails, you get an email.

It is about 400 lines of JavaScript, one dependency (`playwright-core`), and
one workflow file. No server, no SaaS account.

## What it catches

| Problem | What you would see | Result |
| --- | --- | --- |
| Page is down (HTTP 4xx/5xx, no answer) | Error page, or nothing | **Fail** (and nothing else is checked) |
| A stylesheet, script or font returned 4xx/5xx or did not load | Unstyled page, missing feature, fallback font | **Fail** |
| A stylesheet, script or font returned 200 but it is an HTML page (a CDN or host error page in place of the file) | Same as above, but every "status" check says 200 | **Fail** |
| A stylesheet loaded but has no CSS rules (empty or truncated deploy) | Unstyled page | **Fail** |
| JavaScript threw an uncaught error | Half-rendered page, dead buttons | **Fail** |
| The page rendered almost no text (fewer than 20 characters by default) | White screen | **Fail** |
| A sentence you expect is missing (optional `EXPECT_TEXT`) | Wrong or stale page | **Fail** |
| A broken image | Missing picture | Warning (can be made a failure) |
| `console.error` messages | Usually nothing visible | Warning (can be made a failure) |

Why are images and console errors only warnings? Real sites load ads,
analytics and chat widgets that log errors all day. If those failed the
check, you would get alerts you can't fix and would soon stop reading them.
Turn them into failures with `FAIL_ON_IMAGES=1` and `FAIL_ON_CONSOLE_ERROR=1`
when your pages are clean.

When a page fails, the check saves a screenshot, so the email shows you what
your visitors saw.

## Quick start

1. Copy this folder to `site-check/` in the repository of the site you want
   to watch, and copy `workflows/site-check.yml` from it to
   `.github/workflows/site-check.yml` there. (testiv.ai runs exactly this on
   itself.)
2. In the repository, open **Settings → Secrets and variables → Actions →
   Variables** and add `SITE_CHECK_URLS`, for example
   `https://example.com/ https://example.com/pricing`.
3. Optional: add `SITE_CHECK_EXPECT_TEXT` with a sentence that must be on
   every checked page (for example your company name).
4. Merge to the default branch. Scheduled workflows only run from there.
5. Open **Actions → Site check → Run workflow** once to see it work.

It then runs every hour at minute 17.

## What it costs

GitHub Actions bills in whole minutes per job, so even a 40-second run counts
as one minute.

- Hourly at 1–2 minutes a run is about **720–1,440 minutes a month**.
- **Public repositories:** free on GitHub's standard runners.
- **Private repositories:** GitHub Free includes 2,000 minutes a month; Pro and
  Team include 3,000. After that, Linux minutes cost $0.006 each, so even
  the full 1,440 minutes would be about $8.64 if you had no free minutes left.

The minutes are shared with your other workflows, so check what your builds
already use.

## Three ways to get an email

You can use any of these, or all three.

### 1. GitHub's built-in failure email (zero setup)

When the site check fails, the workflow run itself goes red. GitHub emails
failed scheduled runs to **the person who created the workflow, or whoever
last edited the cron line**. Check **Settings → Notifications → Actions** in
your GitHub account so that failed workflows are emailed to you.

The catch: every failed run sends one, so a site that stays broken all day
means up to 24 emails a day.

### 2. One GitHub issue per outage (zero setup)

On the first failure, the workflow opens an issue labelled `site-check` with
the report. While the site stays broken, it only adds a comment to that same
issue. On the first good run, it comments "Recovered" and closes the issue.
A broken site never opens a second issue.

If you watch the repository (the default for repositories you own), GitHub
emails you about the new issue. The issue is also a history of every outage:
when it started, how long it lasted, what broke.

Be aware that the hourly comments can notify people subscribed to the issue
too. Unsubscribe from the thread if that is too noisy and use option 3.

### 3. Your own email, only on "broke" and "fixed"

The workflow sends an email **only when an outage starts** ("Site check
FAILED", with the screenshots attached) **and when it ends** ("Site check
recovered"). No hourly repeats.

For Gmail:

1. Turn on 2-Step Verification for the Google account that will send the
   mail, then create an **App password** for it.
2. In the repository, add two **secrets**: `MAIL_USERNAME` (the Gmail
   address) and `MAIL_PASSWORD` (the app password, not your normal password).
3. Add the **variable** `SITE_CHECK_MAIL_TO` with the address that should
   receive alerts.
4. For another provider, also set `SITE_CHECK_MAIL_SERVER` (for example
   `smtp.fastmail.com`). The port is 465 with TLS.

Without `SITE_CHECK_MAIL_TO`, this step is skipped.

## Prove the alerts before you trust them

An alert you have never seen fire is a guess. Spend five minutes on this:

1. **Actions → Site check → Run workflow**, and in the `urls` box enter a page
   that is broken, for example `https://example.com/this-page-does-not-exist`.
2. Check that the run is red, that an issue labelled `site-check` was opened,
   and that the emails arrived (GitHub's own, and yours if you set up option 3).
   Open the run's artifacts to see the screenshot and `results.json`.
3. **Run workflow** again with the `urls` box **empty**, so it checks your
   real pages.
4. Check that the run is green, the issue got a "Recovered" comment and was
   closed, and the "Site check recovered" email arrived.

If any of those did not happen, fix it now, not during a real outage.

## Limits, in plain words

- **Not to the minute.** Hourly means you can be blind for up to an hour. The
  shortest schedule GitHub allows is every 5 minutes, and scheduled runs "can
  be delayed during periods of high loads", sometimes by a lot. That is why
  this runs at minute 17 and not at :00, the busiest minute.
- **Default branch only.** The schedule only runs from the workflow file on
  the default branch.
- **60-day sleep.** In a public repository, GitHub disables scheduled
  workflows after 60 days without activity in the repository. Re-enable it in
  the Actions tab, or keep committing.
- **One location.** The check runs from GitHub's data centres, not from where
  your users are. A problem that only hits one country or one network will not
  show up.
- **Use it for your own project.** GitHub's terms say hosted runners are for
  work on the software project in the repository. Keep this check in the
  repository of the site it checks; don't turn it into a general monitoring
  service for other people's sites.
- **Third-party noise.** Console errors and broken images are warnings by
  default because third-party scripts produce them constantly (see above).
- **What a browser can see.** It checks what loads on page open. It does not
  log in, click through checkout, or test forms.

## Settings reference

### Workflow (repository variables and secrets)

| Name | Kind | Required | Meaning |
| --- | --- | --- | --- |
| `SITE_CHECK_URLS` | variable | yes | Pages to check, space or comma separated |
| `SITE_CHECK_EXPECT_TEXT` | variable | no | Text every page must contain |
| `SITE_CHECK_MAIL_TO` | variable | no | Turns on option 3; who gets the email |
| `SITE_CHECK_MAIL_SERVER` | variable | no | SMTP server, default `smtp.gmail.com` (port 465) |
| `MAIL_USERNAME` | secret | for option 3 | SMTP user, also used as the sender |
| `MAIL_PASSWORD` | secret | for option 3 | SMTP password (Gmail: an app password) |

### `check.mjs` (environment variables)

| Name | Default | Meaning |
| --- | --- | --- |
| `URLS` | (required) | Pages to check, space or comma separated, `http(s)://` only |
| `EXPECT_TEXT` | none | Text that must appear in the page's visible text |
| `MIN_TEXT_CHARS` | `20` | Minimum visible characters, after collapsing whitespace |
| `FAIL_ON_IMAGES` | off | `1` turns broken images from warnings into failures |
| `FAIL_ON_CONSOLE_ERROR` | off | `1` turns `console.error` from warnings into failures |
| `TIMEOUT_MS` | `30000` | How long to wait for a page to load |
| `OUT_DIR` | `out` | Where `results.json`, `summary.md` and screenshots go |
| `CHROME_CHANNEL` | none | Installed browser to use, e.g. `chrome` (the workflow sets this) |
| `CHROME_PATH` | none | Path to a Chrome/Chromium binary; wins over `CHROME_CHANNEL` |
| `PROXY_SERVER` | none | Proxy for the browser, e.g. `http://proxy:3128` |
| `IGNORE_TLS` | off | `1` accepts invalid HTTPS certificates (staging sites) |

With neither `CHROME_CHANNEL` nor `CHROME_PATH`, it uses Playwright's own
Chromium, which you would have to install yourself
(`npx playwright-core install chromium`). The workflow does not do that: it
uses the Chrome that GitHub's Ubuntu runners already have.

Exit codes: `0` all pages healthy, `1` at least one page failed (or the
browser could not start), `2` bad input (no URLs, a malformed URL, a bad number).

Each page gets a fresh browser at 1280×800. The check waits for the `load`
event, then up to 5 more seconds for the network to go quiet, so pages that
render after fetching data are judged once they have rendered.

## Run it on your machine

```sh
cd site-check
npm ci
CHROME_CHANNEL=chrome URLS="https://example.com/" node check.mjs
```

The tests:

```sh
node --test                                          # unit tests, no browser
CHROME_CHANNEL=chrome node demo/prove-it.mjs         # browser proof
CHROME_PATH=/path/to/chromium node demo/prove-it.mjs # or with any Chromium
```

`demo/site-server.mjs` is a tiny local site that serves the same page in a
dozen ways. Most are broken: `/missing-css/`, `/css-html/`, `/css-empty/`,
`/js-error/`, `/blank/`, `/font-404/`, `/img-404/`, `/console-error/`,
`/down/`. Four are healthy but tricky: `/ok/`, `/late-render/` (renders
after a slow data request), `/css-cross-origin/` (a stylesheet from another
origin, whose rules the page is not allowed to read) and `/analytics-ping/`
(a tracking ping sent as an image request, answered with 200 `text/html`, as
Google Analytics does). `demo/prove-it.mjs` runs the real check against
each one and fails if any result is not exactly what it should be: the right
reason, and nothing extra. Run `node demo/site-server.mjs 8080` to click
through the broken pages yourself. It listens on 127.0.0.1 only; set
`DEMO_HOST=0.0.0.0` to reach it from another machine or container.

## Docker

The `Dockerfile` here builds one image with everything the check needs: Node
22, Playwright's Chromium headless shell, its system libraries and fonts. The
same image runs on your laptop, in a cron job on any server, and in GitHub
Actions, and renders pages the same way every time, because the browser and
fonts are fixed inside it.

### Build and run

```sh
cd site-check
docker build -t site-check .
mkdir -p out && chmod 0777 out
docker run --rm -e URLS="https://example.com" -v "$PWD/out:/app/out" site-check
```

The exit code is the same as without Docker: `0` all pages healthy, `1` at
least one page failed (or the browser could not start), `2` bad input (for
example no `URLS`). `results.json`, `summary.md` and the screenshots of failed
pages land in `out/`.

The container runs as the user `node` (uid 1000), never as root. That user
must be able to write to the folder you mount on `/app/out`, hence the
`chmod` above (or `sudo chown 1000:1000 out`). All settings from the
reference above are passed with `-e`. Nothing is baked into the image: no
URLs, no tokens, no mail settings.

Images built by `.github/workflows/docker-image.yml` (copy it from
`workflows/docker-image.yml` in this folder) are at
`ghcr.io/<owner>/site-check` with three kinds of tag:

| Tag | Example | Changes? |
| --- | --- | --- |
| playwright-core version | `1.64.0` | Yes, every push to the default branch rebuilds it |
| Git tag | `v1.2.0` | No, built once when you push the tag |
| Short commit | `sha-3a78326` | No |

For rendering that never changes underneath you, use a Git tag, a `sha-` tag,
or the image digest (`ghcr.io/<owner>/site-check@sha256:...`). A new package
on GitHub Container Registry is private: either make it public in the
package settings, or `docker login ghcr.io` on the server with a token that
has `read:packages`.

### Cron on any server

```sh
sudo mkdir -p /srv/site-check/out
sudo chown 1000:1000 /srv/site-check/out
```

Then in `crontab -e` (one line; the user needs permission to run `docker`):

```cron
17 * * * * docker run --rm -e URLS="https://example.com/ https://example.com/pricing" -v /srv/site-check/out:/app/out ghcr.io/<owner>/site-check:<version> >/dev/null || mail -s "Site check FAILED" you@example.com < /srv/site-check/out/summary.md
```

The part after `||` runs only when the check exits non-zero. Use anything
that can send the summary: `mail` or `msmtp` on the server, or a Slack
incoming webhook:

```sh
|| jq -Rs '{text: .}' /srv/site-check/out/summary.md | curl -fsS -X POST -H 'Content-Type: application/json' --data @- "$SLACK_WEBHOOK_URL"
```

Keep the webhook URL in the crontab or a file only root can read, not in the
image. Unlike the GitHub workflow, a cron line mails on every failed run, not
only when an outage starts and ends, and screenshots of earlier failures stay
in `out/` until you delete them. A cheap VM running this cron line also gives
you a second location, which GitHub's runners cannot (see "One location"
above).

### Inside GitHub Actions

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/<owner>/site-check:<version>
      # The workspace belongs to the runner user (uid 1001); run as that user
      # so the check can write OUT_DIR. The browser files are readable by all.
      options: --user 1001
    steps:
      - name: Check the site
        run: node /app/check.mjs
        env:
          URLS: ${{ vars.SITE_CHECK_URLS }}
          OUT_DIR: out
```

The trade-off: pulling the image costs about 30–60 seconds on every run,
while the hourly `site-check.yml` workflow uses the Google Chrome already on
the runner and downloads nothing. So `site-check.yml` stays as it is. Use the
image in Actions when you need pinned rendering: the runner's Chrome updates
on its own, which matters as soon as you compare screenshots between runs.
(This `container:` job is an example; this repository's CI does not run it.)

### Pick one environment for baselines

A screenshot taken in this image will not match one taken with the runner's
Chrome or the Chrome on your laptop: different browser build, different fonts,
different text rendering. If you compare screenshots, capture the baseline and
every later screenshot in the same environment, and keep it. When you move to
a new image version, capture new baselines with it.

### Internal sites

For a site behind a proxy or with a self-signed certificate:

```sh
docker run --rm -e URLS="https://intranet.example/" \
  -e PROXY_SERVER="http://proxy.example:3128" -e IGNORE_TLS=1 \
  -v "$PWD/out:/app/out" site-check
```

`PROXY_SERVER` sends the browser's traffic through the proxy. `IGNORE_TLS=1`
accepts invalid certificates; use it for staging or internal sites only. If
the site's name only resolves on the host (a VPN, `/etc/hosts`), add
`--network host` on Linux.

### What the image build proves

`scripts/docker-smoke.sh` is the test for all of this. It builds the `test`
stage, which runs `node --test` and `demo/prove-it.mjs` inside the image, so a
broken checker fails the build. Then it builds the image you run and checks:
no `URLS` exits 2 with the usage line, it runs as uid 1000, `/ms-playwright`
holds only the headless shell (and Playwright's ffmpeg), `/app` holds no demo,
tests or dev dependencies, the image is under 700 MB, and a real run against
the demo site in a second container exits 0 for `/ok/` and 1 for
`/missing-css/` with the screenshot in the mounted `out/`. The workflow runs it
on every pull request that touches `site-check/` and before every push to the
registry.

## What was tested, and what was not

Tested while building this (Linux, Node 22, playwright-core 1.64.0, Chromium
141 through `CHROME_PATH`):

- All 24 browser scenarios in `demo/prove-it.mjs` pass: every broken mode
  fails with the right reason and nothing unrelated, warnings stay warnings
  until switched on, two URLs with one broken gives one failure and one
  screenshot, an unreachable host fails with "load failed", bad input exits 2.
- The harness was shown to catch mistakes: a deliberately wrong expectation
  fails it, and so does each of twelve deliberate bugs planted in the checker
  one at a time (for example "forget to wait for the network", "count a 404 as
  a failed request instead", "stop checking the CSS rule count", "treat an
  unreadable cross-origin stylesheet as empty").
- 30 unit tests (`node --test`) for the incident logic, including that a day
  of failures never opens a second issue, and for the settings parsing.
- The workflow file parses, passes `actionlint`, and its issue-sync script was
  run outside GitHub with stand-in GitHub objects.
- Then on GitHub itself, before merging, with a temporary trigger on the pull
  request branch:
  - A run against a page that 404s went red, used the runner's Google Chrome,
    uploaded the screenshot, and opened an issue labelled `site-check`.
  - A run against the live home page went green, commented "Recovered" on
    that issue and closed it.
  - That second run also caught a false alarm: Google Analytics pings were
    reported as broken images. That is fixed and covered by the
    `/analytics-ping/` demo page.

Not tested, so prove it yourself with the steps above:

- The hourly `schedule` trigger and GitHub's email for failed scheduled runs
  (both only work once the workflow is on the default branch).
- Whether the hourly issue comments email you.
- Sending real email through SMTP (option 3).
- Playwright's own downloaded Chromium (the default with no `CHROME_*` set).
