#!/usr/bin/env bash
# Build the hybrid-app fixture (e2e/fixtures/android-webview) into a signed
# APK with the Android SDK's own tools, no Gradle: javac, d8, aapt2, zipalign,
# apksigner. Needs ANDROID_HOME with a platform (android-34 or newer) and
# build-tools, as on GitHub's ubuntu runners. Usage: build-webview-apk.sh <out.apk>
set -euo pipefail

OUT_APK="${1:?usage: build-webview-apk.sh <out.apk>}"
SDK="${ANDROID_HOME:?set ANDROID_HOME}"
HERE="$(cd "$(dirname "$0")/../fixtures/android-webview" && pwd)"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
PLATFORM_DIR="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)"
ANDROID_JAR="$PLATFORM_DIR/android.jar"
echo "build-tools: $BT"
echo "platform:    $PLATFORM_DIR"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/classes" "$WORK/dex"

javac -source 11 -target 11 -nowarn -classpath "$ANDROID_JAR" -d "$WORK/classes" \
  $(find "$HERE/src" -name '*.java')
"$BT/d8" --lib "$ANDROID_JAR" --min-api 24 --output "$WORK/dex" $(find "$WORK/classes" -name '*.class')

"$BT/aapt2" link -o "$WORK/unsigned.apk" -I "$ANDROID_JAR" \
  --manifest "$HERE/AndroidManifest.xml" -A "$HERE/assets" \
  --min-sdk-version 24 --target-sdk-version 34 --version-code 1 --version-name 1.0
(cd "$WORK/dex" && zip -q "$WORK/unsigned.apk" classes.dex)

"$BT/zipalign" -f -p 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"
keytool -genkeypair -keystore "$WORK/debug.keystore" -storepass android -keypass android \
  -alias fixture -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=TestivAI fixture" >/dev/null 2>&1
"$BT/apksigner" sign --ks "$WORK/debug.keystore" --ks-pass pass:android --key-pass pass:android \
  --out "$OUT_APK" "$WORK/aligned.apk"
"$BT/apksigner" verify "$OUT_APK"
echo "built $OUT_APK ($(wc -c < "$OUT_APK") bytes)"
