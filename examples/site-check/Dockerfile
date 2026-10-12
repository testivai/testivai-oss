# Site check in one image: Node, Playwright's Chromium headless shell, its
# system libraries and fonts. Renders the same on a laptop, a VPS cron job
# and GitHub Actions. Build from site-check/:
#
#   docker build -t site-check .                  # the image you run
#   docker build --target test -t site-check:test .  # runs the proof; fails if the checker is broken
#
# See README.md ("Docker").

# node:22-bookworm-slim, pinned by digest so a rebuild starts from the same
# base. Dependabot proposes digest updates (.github/dependabot.yml).
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base

# The browser lives outside the home directory, shared by any user.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

COPY package.json package-lock.json ./
# Only the headless shell, not full Chromium, Firefox or WebKit. --with-deps
# apt-installs its libraries and fonts. It also installs xvfb, an X server
# for headed browsers that the headless shell never uses; it pulls in Mesa and
# LLVM, so it is purged with everything only it needed (the fonts and browser
# libraries were installed by name and stay). Everything runs in one layer: the
# apt lists and npm cache are gone before the layer is saved, and a chown in a
# later layer would store a second copy of every browser file.
RUN npm ci --omit=dev \
  && npx playwright-core install --with-deps --only-shell chromium \
  && apt-get purge -y --auto-remove xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && npm cache clean --force \
  && mkdir /app/out \
  && chown -R node:node /app /ms-playwright

COPY --chown=node:node check.mjs ./

USER node
ENV OUT_DIR=/app/out NODE_ENV=production
ENTRYPOINT ["node", "check.mjs"]

# The proof: unit tests and every browser scenario against the demo site,
# inside this image. The demo server binds 127.0.0.1, so no network setup.
FROM base AS test
COPY demo/ ./demo/
COPY check.test.mjs incident*.mjs ./
RUN node --test && node demo/prove-it.mjs

# The image you run is the base stage: no demo, no tests, no dev files.
# Last, so a plain `docker build` builds it and skips the test stage.
FROM base AS final
