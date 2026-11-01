#!/usr/bin/env bash
# The Android emulator checks: start Appium, run the native-mode check
# (e2e/src/android-native.ts) and, when $TESTIVAI_WEBVIEW_APK is set, the
# hybrid WebView check (e2e/src/android-webview.ts), stop Appium. Both run
# even when the first fails; the script fails when either does. Run by
# .github/workflows/android-native.yml inside android-emulator-runner, with
# appium and its UiAutomator2 driver installed globally. Appium may download
# the chromedriver that matches the emulator's WebView.
set -euo pipefail

OUT="${TESTIVAI_ANDROID_OUT:?set TESTIVAI_ANDROID_OUT}"
mkdir -p "$OUT"

adb wait-for-device
adb shell getprop ro.build.version.release | sed 's/^/Android /'

appium --address 127.0.0.1 --port 4723 --log "$OUT/appium.log" --log-no-colors \
  --allow-insecure uiautomator2:chromedriver_autodownload &
APPIUM_PID=$!
trap 'kill "$APPIUM_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:4723/status >/dev/null; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:4723/status >/dev/null || { echo "Appium did not start; see appium.log"; exit 1; }

status=0
pnpm --filter @testivai-oss/e2e run test:android || status=1
if [ -n "${TESTIVAI_WEBVIEW_APK:-}" ]; then
  TESTIVAI_WEBVIEW_OUT="$OUT/webview" pnpm --filter @testivai-oss/e2e run test:android-webview || status=1
fi
exit "$status"
