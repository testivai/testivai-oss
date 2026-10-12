#!/usr/bin/env bash
# Docker smoke test: builds the site-check image and proves it works.
#
#   1. The test stage runs the unit tests and the browser proof inside the
#      image, so a broken checker fails the build.
#   2. The final image is checked from the outside: exit codes, user, browser
#      directory, contents, size, and a real run against the demo site in a
#      second container.
#
# Run from anywhere:  site-check/scripts/docker-smoke.sh
# IMAGE=name:tag overrides the local tag of the final image.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TEST_IMAGE=site-check:test
IMAGE=${IMAGE:-site-check:local}
MAX_MB=700
run_id="site-check-smoke-$$"
network="$run_id"
demo="$run_id-demo"
out="$(mktemp -d)"

pass() { printf 'PASS %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}

cleanup() {
  docker rm -f "$demo" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$out"
}
trap cleanup EXIT

echo '== Test stage (node --test and demo/prove-it.mjs inside the image)'
docker build --target test -t "$TEST_IMAGE" .
pass 'test stage built: unit tests and browser proof passed inside the image'

echo '== Final image'
docker build -t "$IMAGE" .
pass "built $IMAGE"

echo '== No URLS: bad input'
code=0
output=$(docker run --rm "$IMAGE" 2>&1) || code=$?
[[ $code -eq 2 ]] || fail "no URLS should exit 2, got $code. Output: $output"
grep -q 'No URLS given. Set URLS to one or more page URLs' <<<"$output" ||
  fail "no URLS should print the usage line. Output: $output"
pass 'no URLS exits 2 and prints the usage line'

echo '== Runtime user'
ids=$(docker run --rm --entrypoint id "$IMAGE")
echo "$ids"
[[ $ids == uid=1000\(node\)\ gid=1000\(node\)* ]] || fail "should run as node (uid 1000), got: $ids"
pass 'runs as node, uid 1000'

echo '== Browser directory'
browsers=$(docker run --rm --entrypoint sh "$IMAGE" -c 'ls -1 /ms-playwright')
echo "$browsers"
grep -q '^chromium_headless_shell-' <<<"$browsers" || fail 'chromium headless shell is missing'
# Playwright always installs its ffmpeg next to the shell; anything else is a
# browser this check does not need.
extra=$(grep -v -e '^chromium_headless_shell-' -e '^ffmpeg-' <<<"$browsers" || true)
[[ -z $extra ]] || fail "unexpected browsers in /ms-playwright: $extra"
pass 'only the chromium headless shell (plus ffmpeg) is installed'

echo '== Image contents'
app=$(docker run --rm --entrypoint sh "$IMAGE" -c 'ls -1A /app | LC_ALL=C sort | tr "\n" " "')
expected='check.mjs node_modules out package-lock.json package.json '
[[ $app == "$expected" ]] || fail "/app should hold only [$expected], got [$app]"
modules=$(docker run --rm --entrypoint sh "$IMAGE" -c 'ls -1 /app/node_modules | tr "\n" " "')
[[ $modules == 'playwright-core ' ]] || fail "node_modules should hold only playwright-core, got [$modules]"
pass 'no demo, tests or dev dependencies in the final image'

echo '== Image size'
bytes=$(docker image inspect --format '{{.Size}}' "$IMAGE")
mb=$((bytes / 1000 / 1000))
echo "Image size: ${mb} MB (${bytes} bytes)"
# Where the size goes, so a failure here says what to cut.
docker run --rm --entrypoint sh "$IMAGE" -c '
  echo "Largest Debian packages (KB):"
  dpkg-query -Wf "\${Installed-Size}\t\${Package}\n" | sort -rn | head -12
  echo "Largest directories:"
  du -sh /ms-playwright/* /app/node_modules /usr/local/lib/node_modules /usr/lib /usr/share/fonts 2>/dev/null' || true
((mb <= MAX_MB)) || fail "image is ${mb} MB, above the ${MAX_MB} MB limit"
pass "image size ${mb} MB is within ${MAX_MB} MB"

echo '== Real run against the demo site in a second container'
docker network create "$network" >/dev/null
docker run -d --name "$demo" --network "$network" --network-alias demo \
  -e DEMO_HOST=0.0.0.0 --entrypoint node "$TEST_IMAGE" demo/site-server.mjs 3200 >/dev/null
# Read the logs first: `docker logs | grep -q` fails under pipefail when grep
# exits at the first match and docker logs gets SIGPIPE.
for _ in $(seq 1 30); do
  logs=$(docker logs "$demo" 2>&1)
  grep -q 'Demo site on' <<<"$logs" && break
  sleep 1
done
grep -q 'Demo site on' <<<"$logs" || fail "demo server did not start: $logs"

# The container runs as uid 1000, which usually differs from the host user
# that owns the bind-mounted directory, so the directory must be writable for all.
run_check() {
  local url=$1 dir=$2
  mkdir -p "$dir"
  chmod 0777 "$dir"
  docker run --rm --network "$network" -e URLS="$url" -v "$dir:/app/out" "$IMAGE"
}

code=0
run_check http://demo:3200/ok/ "$out/ok" || code=$?
[[ $code -eq 0 ]] || fail "/ok/ should exit 0, got $code"
grep -q '"ok": true' "$out/ok/results.json" || fail '/ok/ results.json should say ok: true'
pass '/ok/ exits 0 and writes results.json to the bind mount'

code=0
run_check http://demo:3200/missing-css/ "$out/missing-css" || code=$?
[[ $code -eq 1 ]] || fail "/missing-css/ should exit 1, got $code"
grep -q 'stylesheet http://demo:3200/missing-css/style.css returned HTTP 404' "$out/missing-css/results.json" ||
  fail '/missing-css/ should fail on the 404 stylesheet'
shopt -s nullglob
shots=("$out/missing-css"/*.png)
shopt -u nullglob
((${#shots[@]} == 1)) || fail "expected one screenshot in out/, found ${#shots[@]}"
magic=$(od -An -tx1 -N8 "${shots[0]}" | tr -d ' \n')
[[ $magic == 89504e470d0a1a0a ]] || fail "${shots[0]} is not a PNG"
pass "/missing-css/ exits 1 and saves $(basename "${shots[0]}") to the bind mount"

echo 'All Docker smoke checks passed.'
