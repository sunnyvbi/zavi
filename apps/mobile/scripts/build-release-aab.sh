#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$MOBILE_DIR/android"
AAB_PATH="$ANDROID_DIR/app/build/outputs/bundle/release/app-release.aab"
DESKTOP_DIR="/Users/imac/Desktop"
OUTPUT_PATH="$DESKTOP_DIR/Zavi-v1.4-code4-release.aab"

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

(
  cd "$ANDROID_DIR"
  export EXPO_PUBLIC_APP_ENV=production
  ./gradlew :app:bundleRelease
)

if [[ ! -s "$AAB_PATH" ]]; then
  echo "Gradle completed without producing $AAB_PATH" >&2
  exit 1
fi

if [[ -e "$OUTPUT_PATH" ]]; then
  OUTPUT_PATH="$DESKTOP_DIR/Zavi-v1.4-code4-release-$(date +%Y%m%d-%H%M%S).aab"
fi

cp "$AAB_PATH" "$OUTPUT_PATH"
echo "AAB copied to: $OUTPUT_PATH"
