#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$MOBILE_DIR/android"
DESKTOP_DIR="/Users/imac/Desktop"
OUTPUT_PATH="$DESKTOP_DIR/Zavi PR 11.09.26.apk"

if [[ ! -x "$ANDROID_DIR/gradlew" ]]; then
  echo "Missing Android Gradle wrapper: $ANDROID_DIR/gradlew" >&2
  exit 1
fi

if [[ ! -f "$ANDROID_DIR/app/release.keystore" ]]; then
  echo "Missing release keystore: $ANDROID_DIR/app/release.keystore" >&2
  exit 1
fi

if [[ ! -f "$ANDROID_DIR/gradle.properties" ]] || ! grep -q '^ZAVI_RELEASE_STORE_FILE=' "$ANDROID_DIR/gradle.properties"; then
  echo "Release signing properties are missing from android/gradle.properties" >&2
  exit 1
fi

APK_PATH="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"

(
  cd "$ANDROID_DIR"
  export EXPO_PUBLIC_APP_ENV=development
  ./gradlew :app:assembleRelease
)

if [[ ! -s "$APK_PATH" ]]; then
  echo "Gradle completed without producing $APK_PATH" >&2
  exit 1
fi

if [[ -e "$OUTPUT_PATH" ]]; then
  OUTPUT_PATH="$DESKTOP_DIR/Zavi PR 11.09.26-$(date +%Y%m%d-%H%M%S).apk"
fi

cp "$APK_PATH" "$OUTPUT_PATH"
echo "APK copied to: $OUTPUT_PATH"
