#!/usr/bin/env bash
# The Android native-mode check (e2e/src/android-native.ts): start Appium,
# run the check against the booted emulator, stop Appium. Run by
# .github/workflows/android-native.yml inside android-emulator-runner, with
# appium and its UiAutomator2 driver installed globally.
set -euo pipefail

OUT="${TESTIVAI_ANDROID_OUT:?set TESTIVAI_ANDROID_OUT}"
mkdir -p "$OUT"

adb wait-for-device
adb shell getprop ro.build.version.release | sed 's/^/Android /'

appium --address 127.0.0.1 --port 4723 --log "$OUT/appium.log" --log-no-colors &
APPIUM_PID=$!
trap 'kill "$APPIUM_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:4723/status >/dev/null; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:4723/status >/dev/null || { echo "Appium did not start; see appium.log"; exit 1; }

pnpm --filter @testivai-oss/e2e run test:android
