#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$REPO_DIR/apps/mobile"
ANDROID_DIR="$MOBILE_DIR/android"
APP_ID="com.zaviagent.app"
DEV_CLIENT_SCHEME="exp+zavi"
DESKTOP_DIR="$HOME/Desktop"

DEVICE_ARG=""
WIFI_ARG=""
MODE_ARG=""
PORT=8081
CLEAR_CACHE=0
ASSUME_YES=0
SHOW_LOGS=0

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
fi
step() { printf '\n%s==>%s %s%s%s\n' "$CYAN" "$RESET" "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '\n%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

usage() {
  cat <<EOF
${BOLD}Run Zavi on a device${RESET}

Usage: $(basename "$0") [options]

Options:
  -m, --mode MODE     metro | metro-only | release | apk
  -d, --device ID     adb serial (e.g. emulator-5554, 192.168.1.18:5555) or an
                      emulator name (e.g. Pixel_7, booted if not running)
  -w, --wifi IP[:PORT]
                      connect a phone over Wi-Fi first (port defaults to 5555),
                      then use it. The last Wi-Fi phone reconnects on its own.
  -p, --port PORT     Metro port (default 8081)
  -c, --clear         clear the Metro cache on start
  -l, --logs          release mode: stream the app's logs after launch
  -y, --yes           don't ask before uninstalling on a signature clash
  -h, --help          show this help

Without -m or -d you get a menu for each.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--device) DEVICE_ARG="${2:-}"; [[ -n "$DEVICE_ARG" ]] || die "$1 needs a value"; shift 2 ;;
    -w|--wifi)   WIFI_ARG="${2:-}";   [[ -n "$WIFI_ARG" ]]   || die "$1 needs a value"; shift 2 ;;
    -m|--mode)   MODE_ARG="${2:-}";   [[ -n "$MODE_ARG" ]]   || die "$1 needs a value"; shift 2 ;;
    -p|--port)   PORT="${2:-}"; shift 2 ;;
    -c|--clear)  CLEAR_CACHE=1; shift ;;
    -l|--logs)   SHOW_LOGS=1; shift ;;
    -y|--yes)    ASSUME_YES=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
done
[[ "$PORT" =~ ^[0-9]+$ ]] || die "Port must be a number, got: $PORT"
case "$MODE_ARG" in ""|metro|metro-only|release|apk) ;; *) die "Mode must be metro, metro-only, release or apk, got: $MODE_ARG" ;; esac

confirm() { # confirm "question" -> 0 for yes
  local reply
  if [[ $ASSUME_YES -eq 1 ]]; then return 0; fi
  [[ -t 0 ]] || return 1
  read -r -p "    $1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}

pick() { # pick "prompt" count -> echoes a 1-based choice
  local prompt="$1" count="$2" reply
  [[ -t 0 ]] || die "No terminal to ask on. Pass the choice as a flag (see -h)."
  while true; do
    read -r -p "$prompt [1-$count]: " reply
    if [[ "$reply" =~ ^[0-9]+$ ]] && (( reply >= 1 && reply <= count )); then
      echo "$reply"; return
    fi
    printf '    %sPick a number from 1 to %s.%s\n' "$YELLOW" "$count" "$RESET" >&2
  done
}

step "Checking tools"
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
[[ -d "$ANDROID_HOME" ]] || die "Android SDK not found at $ANDROID_HOME. Set ANDROID_HOME."
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
command -v adb >/dev/null || die "adb not found. Install Android SDK platform-tools."
command -v node >/dev/null || die "node not found."

if [[ -z "${JAVA_HOME:-}" || ! -x "${JAVA_HOME:-}/bin/java" ]]; then
  JAVA_HOME=""
  for candidate in "$HOME/Library/Java/JavaVirtualMachines/jbr-21"*/Contents/Home \
                   "$HOME/Library/Java/JavaVirtualMachines/jbr-17"*/Contents/Home \
                   "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    if [[ -x "$candidate/bin/java" ]]; then JAVA_HOME="$candidate"; break; fi
  done
  [[ -n "$JAVA_HOME" ]] || JAVA_HOME="$(/usr/libexec/java_home -v 17+ 2>/dev/null || true)"
  export JAVA_HOME
fi
[[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]] || die "No JDK 17+ found. Set JAVA_HOME."
ok "Android SDK  $ANDROID_HOME"
ok "JDK          $JAVA_HOME"

[[ -x "$ANDROID_DIR/gradlew" ]] || die "Missing $ANDROID_DIR. Run 'npx expo prebuild --platform android' in apps/mobile first."
[[ -f "$MOBILE_DIR/.env" ]] || die "Missing apps/mobile/.env. Copy .env.example and fill it (see apps/mobile/README.md)."
if [[ "$MOBILE_DIR/app.json" -nt "$ANDROID_DIR/app/build.gradle" || "$MOBILE_DIR/app.config.ts" -nt "$ANDROID_DIR/app/build.gradle" ]]; then
  warn "app.json is newer than android/. If you changed native config, run 'npx expo prebuild --platform android'."
fi
if [[ ! -f "$REPO_DIR/packages/shared/dist/index.js" ]]; then
  step "Building @zavi/shared (missing dist/)"
  (cd "$REPO_DIR" && npm run build -w @zavi/shared)
fi
BRANCH="$(git -C "$REPO_DIR" branch --show-current 2>/dev/null || true)"
[[ -n "$BRANCH" ]] && ok "Branch       $BRANCH"

MODE="$MODE_ARG"
if [[ -z "$MODE" ]]; then
  step "How do you want to run it?"
  printf '  %s1)%s Metro       %sdebug build, install, start Metro with hot reload%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
  printf '  %s2)%s Metro only  %sapp already installed, just start Metro and connect%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
  printf '  %s3)%s Release     %srelease build, install, launch (no Metro)%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
  printf '  %s4)%s APK         %srelease APK for every phone, copied to the Desktop%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
  echo
  case "$(pick "Mode" 4)" in 1) MODE="metro" ;; 2) MODE="metro-only" ;; 3) MODE="release" ;; 4) MODE="apk" ;; esac
fi

ABI=""   # empty = every architecture in android/gradle.properties

build_apk() { # build_apk debug|release -> sets APK
  local variant="$1" task key missing=0
  task="assemble$(tr '[:lower:]' '[:upper:]' <<<"${variant:0:1}")${variant:1}"
  step "Building $variant APK for ${ABI:-all CPU types}"
  local gradle_args=("app:$task" --console=plain)
  [[ -n "$ABI" ]] && gradle_args+=("-PreactNativeArchitectures=$ABI")
  for key in ZAVI_RELEASE_STORE_PASSWORD ZAVI_RELEASE_KEY_ALIAS ZAVI_RELEASE_KEY_PASSWORD; do
    if ! grep -q "^$key=" "$ANDROID_DIR/gradle.properties" && [[ -z "${!key:-}" ]]; then
      gradle_args+=("-P$key="); missing=1
    fi
  done
  if [[ "$variant" == "release" && $missing -eq 1 ]]; then
    if grep -q "signingConfig signingConfigs.release" "$ANDROID_DIR/app/build.gradle"; then
      die "Release signing secrets are missing. Add apps/mobile/.secrets/ (see apps/mobile/docs/android-release-signing-setup.md)."
    fi
    info "${DIM}No release keystore on this Mac: the release APK is signed with the debug key (fine for testing, not for the Play Store).${RESET}"
  fi
  (cd "$ANDROID_DIR" && ./gradlew "${gradle_args[@]}") \
    || die "Gradle build failed (scroll up for the first error)."
  APK="$ANDROID_DIR/app/build/outputs/apk/$variant/app-$variant.apk"
  [[ -s "$APK" ]] || die "Gradle finished but $APK is missing."
  ok "Built $(du -h "$APK" | cut -f1 | tr -d ' ') APK"
}

if [[ "$MODE" == "apk" ]]; then
  build_apk release
  version="$(grep -m1 'versionName' "$ANDROID_DIR/app/build.gradle" | sed -E 's/.*"([^"]+)".*/\1/')"
  name="Zavi-v${version:-dev}-${BRANCH:-local}-$(date +%Y-%m-%d)"
  out="$DESKTOP_DIR/$name.apk"
  [[ -e "$out" ]] && out="$DESKTOP_DIR/$name-$(date +%H%M%S).apk"
  cp "$APK" "$out"
  ok "Copied to $out"
  exit 0
fi

adb start-server >/dev/null 2>&1 || true

# ---------- Wi-Fi ----------
LAST_WIFI_FILE="$MOBILE_DIR/.expo/last-wifi-device"   # .expo/ is gitignored
WIFI_SERIAL=""

wifi_connect() { # wifi_connect host[:port] -> 0 once adb sees it; sets WIFI_SERIAL
  local addr="$1" out
  [[ "$addr" == *:* ]] || addr="$addr:5555"
  # Probe first: adb connect to an unreachable host hangs for a long time.
  nc -z -G 3 "${addr%:*}" "${addr##*:}" >/dev/null 2>&1 || return 1
  out="$(adb connect "$addr" 2>&1 || true)"
  [[ "$out" == *"connected to"* ]] || return 1
  sleep 1
  [[ "$(adb -s "$addr" get-state 2>/dev/null)" == "device" ]] || return 1
  mkdir -p "$(dirname "$LAST_WIFI_FILE")" && printf '%s\n' "$addr" >"$LAST_WIFI_FILE"
  WIFI_SERIAL="$addr"
}

wifi_help() {
  info "On the phone: Settings > Developer options > turn on ${BOLD}Wireless debugging${RESET}"
  info "(Android 11+), then pair once with a code. Or plug it in by USB once and run"
  info "'adb tcpip 5555'; after that it connects at <phone IP>:5555 until it reboots."
}

wifi_pair_and_connect() {
  local pair_addr code addr
  info "On the phone: Wireless debugging > ${BOLD}Pair device with pairing code${RESET}."
  read -r -p "    Pairing IP:port shown in that dialog: " pair_addr
  read -r -p "    Six-digit code: " code
  adb pair "$pair_addr" "$code" || return 1
  info "Paired. Now the ${BOLD}IP address & Port${RESET} at the top of the Wireless debugging screen."
  read -r -p "    IP:port: " addr
  wifi_connect "$addr"
}

connect_wifi_interactive() {
  local addr
  read -r -p "    Phone's IP or IP:port (Settings > About phone > Status): " addr
  [[ -n "$addr" ]] || return 1
  if wifi_connect "$addr"; then ok "Connected to $WIFI_SERIAL"; return 0; fi
  warn "Couldn't connect to $addr."
  wifi_help
  if confirm "Pair with a code now?" && wifi_pair_and_connect; then ok "Connected to $WIFI_SERIAL"; return 0; fi
  return 1
}

# Reconnect the last Wi-Fi phone if adb has lost it (phone slept, adb restarted).
if [[ -f "$LAST_WIFI_FILE" ]]; then
  last_wifi="$(head -n1 "$LAST_WIFI_FILE" | tr -d '[:space:]')"
  if [[ -n "$last_wifi" ]] && ! adb devices | grep -q "^$last_wifi[[:space:]]"; then
    if wifi_connect "$last_wifi"; then ok "Reconnected Wi-Fi phone $last_wifi"; fi
  fi
fi

if [[ -n "$WIFI_ARG" ]]; then
  step "Connecting over Wi-Fi to $WIFI_ARG"
  wifi_connect "$WIFI_ARG" || { wifi_help; die "Couldn't connect to $WIFI_ARG."; }
  ok "Connected to $WIFI_SERIAL"
  [[ -n "$DEVICE_ARG" ]] || DEVICE_ARG="$WIFI_SERIAL"
fi

# ---------- device list ----------
# Parallel arrays, one entry per row of the menu.
collect_devices() {
  D_KIND=()   # usb | wifi | emulator | avd
  D_ID=()     # adb serial, or AVD name for a stopped emulator
  D_STATE=()  # device | unauthorized | offline | stopped
  D_LABEL=()
  local serial state rest kind label avd ver running_avds=" "
  while read -r serial state rest; do
    [[ -z "$serial" || "$serial" == "List" || "$serial" == "*" ]] && continue
    kind="usb"; [[ "$serial" == *:* || "$serial" == *._adb-tls-connect._tcp* ]] && kind="wifi"
    label=""
    if [[ "$serial" == emulator-* ]]; then
      kind="emulator"
      avd="$(adb -s "$serial" emu avd name 2>/dev/null | head -n1 | tr -d '\r' || true)"
      if [[ -n "$avd" ]]; then running_avds="$running_avds$avd "; label="${avd//_/ }"; fi
    fi
    if [[ -z "$label" && "$rest" =~ model:([^[:space:]]+) ]]; then
      label="${BASH_REMATCH[1]//_/ }"
    fi
    [[ -z "$label" ]] && label="Unknown device"
    if [[ "$state" == "device" ]]; then
      ver="$(adb -s "$serial" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r' || true)"
      [[ -n "$ver" ]] && label="$label (Android $ver)"
    fi
    D_KIND+=("$kind"); D_ID+=("$serial"); D_STATE+=("$state"); D_LABEL+=("$label")
  done < <(adb devices -l 2>/dev/null)

  if command -v emulator >/dev/null; then
    while read -r avd; do
      avd="$(printf '%s' "$avd" | tr -d '\r')"
      [[ -z "$avd" || "$avd" == INFO* ]] && continue
      [[ "$running_avds" == *" $avd "* ]] && continue
      D_KIND+=("avd"); D_ID+=("$avd"); D_STATE+=("stopped"); D_LABEL+=("${avd//_/ }")
    done < <(emulator -list-avds 2>/dev/null || true)
  fi
  COUNT=${#D_ID[@]}
}

kind_tag() {
  case "$1" in
    usb) echo "USB" ;; wifi) echo "Wi-Fi" ;; emulator) echo "Emulator" ;; avd) echo "Emulator, not running" ;;
  esac
}

find_device() { # find_device ID -> sets SEL, or -1
  local i
  SEL=-1
  for ((i = 0; i < COUNT; i++)); do
    if [[ "${D_ID[$i]}" == "$1" ]]; then SEL=$i; return; fi
  done
  # Also accept the AVD name of an emulator that is already running.
  for ((i = 0; i < COUNT; i++)); do
    if [[ "${D_KIND[$i]}" == "emulator" && "${D_LABEL[$i]}" == "${1//_/ }"* ]]; then SEL=$i; return; fi
  done
}

collect_devices
if [[ -n "$DEVICE_ARG" ]]; then
  find_device "$DEVICE_ARG"
  # An IP that adb doesn't know yet: try it over Wi-Fi.
  if [[ $SEL -lt 0 && "$DEVICE_ARG" =~ ^[0-9]+(\.[0-9]+){3}(:[0-9]+)?$ ]] && wifi_connect "$DEVICE_ARG"; then
    ok "Connected to $WIFI_SERIAL over Wi-Fi"
    collect_devices; find_device "$WIFI_SERIAL"
  fi
  [[ $SEL -ge 0 ]] || die "Device '$DEVICE_ARG' not found. Run without -d to see the list."
else
  while true; do
    step "Pick a device"
    for ((i = 0; i < COUNT; i++)); do
      note=""
      case "${D_STATE[$i]}" in
        unauthorized) note=" ${YELLOW}needs USB debugging approval on the phone${RESET}" ;;
        offline)      note=" ${RED}offline${RESET}" ;;
      esac
      printf '  %s%2d)%s %-34s %s%-22s%s %s%s\n' "$BOLD" $((i + 1)) "$RESET" "${D_LABEL[$i]}" \
        "$DIM" "$(kind_tag "${D_KIND[$i]}")" "$RESET" "$( [[ ${D_KIND[$i]} == avd ]] || echo "${D_ID[$i]}")" "$note"
    done
    printf '  %s%2d)%s %sConnect a phone over Wi-Fi...%s\n' "$BOLD" $((COUNT + 1)) "$RESET" "$CYAN" "$RESET"
    echo
    choice="$(pick "Device" $((COUNT + 1)))"
    if (( choice <= COUNT )); then SEL=$((choice - 1)); break; fi
    if connect_wifi_interactive; then
      collect_devices; find_device "$WIFI_SERIAL"
      [[ $SEL -ge 0 ]] && break
    fi
  done
fi

KIND="${D_KIND[$SEL]}"; SERIAL="${D_ID[$SEL]}"; STATE="${D_STATE[$SEL]}"; LABEL="${D_LABEL[$SEL]}"

# ---------- bring the device online ----------
wait_for_boot() { # wait_for_boot serial timeout_seconds
  local serial="$1" limit="$2" waited=0
  adb -s "$serial" wait-for-device >/dev/null 2>&1 || true
  until [[ "$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do
    (( waited >= limit )) && return 1
    sleep 2; waited=$((waited + 2))
  done
}

if [[ "$KIND" == "avd" ]]; then
  step "Starting emulator $LABEL"
  before="$(adb devices | awk '/^emulator-/{print $1}' | sort)"
  log="${TMPDIR:-/tmp/}"; log="${log%/}/zavi-emulator-$SERIAL.log"
  # Own session, so the emulator outlives this script and Metro's Ctrl+C.
  nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' \
    emulator -avd "$SERIAL" -netdelay none -netspeed full </dev/null >"$log" 2>&1 &
  info "Emulator log: $log"
  new_serial=""; waited=0
  while [[ -z "$new_serial" ]]; do
    (( waited >= 90 )) && die "Emulator did not appear in adb after 90s. See $log"
    sleep 2; waited=$((waited + 2))
    new_serial="$(comm -13 <(printf '%s\n' "$before") <(adb devices | awk '/^emulator-/{print $1}' | sort) | head -n1)"
  done
  SERIAL="$new_serial"
  info "Waiting for Android to finish booting ($SERIAL)..."
  wait_for_boot "$SERIAL" 240 || die "Emulator did not finish booting in 4 minutes. See $log"
  ok "Emulator ready: $SERIAL"
elif [[ "$STATE" == "unauthorized" ]]; then
  step "Waiting for USB debugging approval"
  info "Unlock the phone and tap ${BOLD}Allow${RESET} on the 'Allow USB debugging?' prompt."
  waited=0
  until [[ "$(adb -s "$SERIAL" get-state 2>/dev/null)" == "device" ]]; do
    (( waited >= 60 )) && die "Not approved after 60s. Replug the cable and try again."
    sleep 2; waited=$((waited + 2))
  done
  ok "Approved"
elif [[ "$STATE" == "offline" ]]; then
  die "$LABEL is offline. Replug it (or run 'adb kill-server') and try again."
fi

# From here on every adb call targets the chosen device.
export ANDROID_SERIAL="$SERIAL"
ABI="$(adb shell getprop ro.product.cpu.abi | tr -d '\r')"
[[ -n "$ABI" ]] || die "Could not read the CPU type from $SERIAL."

step "Target"
info "Device  ${BOLD}$LABEL${RESET}  ($SERIAL, $ABI)"
info "Mode    ${BOLD}$MODE${RESET}"

# ---------- device helpers ----------
installed_kind() { # prints none | debug | release
  if [[ -z "$(adb shell pm path "$APP_ID" 2>/dev/null | tr -d '\r')" ]]; then echo none
  elif adb shell dumpsys package "$APP_ID" 2>/dev/null | grep -q "flags=\[.*DEBUGGABLE"; then echo debug
  else echo release; fi
}

install_apk() {
  local out
  step "Installing on $LABEL"
  if out="$(adb install -r -d "$APK" 2>&1)"; then ok "Installed"; return; fi
  if [[ "$out" == *INSTALL_FAILED_UPDATE_INCOMPATIBLE* || "$out" == *"signatures do not match"* ]]; then
    warn "The installed Zavi is signed with a different key, so it can't be updated in place."
    warn "Uninstalling removes the app's data on this device (you'll need to log in again)."
    confirm "Uninstall and reinstall?" || die "Stopped. Nothing was changed."
    adb uninstall "$APP_ID" >/dev/null
    out="$(adb install "$APK" 2>&1)" || die "Install failed: $out"
    ok "Installed (fresh)"
  elif [[ "$out" == *INSUFFICIENT_STORAGE* ]]; then
    die "Not enough storage on the device."
  else
    die "Install failed: $out"
  fi
}

metro_running() {
  curl -fs --max-time 2 "http://localhost:$PORT/status" 2>/dev/null | grep -q "packager-status:running"
}

open_in_dev_client() {
  local url="http%3A%2F%2Flocalhost%3A$PORT"
  adb shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
  adb shell am start -a android.intent.action.VIEW \
    -d "$DEV_CLIENT_SCHEME://expo-development-client/?url=$url" "$APP_ID" >/dev/null
}

# ---------- run ----------
if [[ "$MODE" == "release" ]]; then
  build_apk release
  install_apk
  step "Launching Zavi"
  adb shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
  adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 \
    || die "Could not launch $APP_ID."
  ok "Zavi (release) is running on $LABEL"
  if [[ $SHOW_LOGS -eq 1 ]]; then
    sleep 2
    pid="$(adb shell pidof "$APP_ID" 2>/dev/null | tr -d '\r' | awk '{print $1}')"
    [[ -n "$pid" ]] || die "App is not running (it may have crashed on start). Try: adb -s $SERIAL logcat -b crash"
    step "App logs (Ctrl+C to stop)"
    exec adb logcat --pid="$pid"
  fi
  info "${DIM}Logs: adb -s $SERIAL logcat --pid=\$(adb -s $SERIAL shell pidof $APP_ID)${RESET}"
  exit 0
fi

if [[ "$MODE" == "metro" ]]; then
  build_apk debug
  install_apk
else
  case "$(installed_kind)" in
    none)
      warn "Zavi is not installed on $LABEL."
      confirm "Build and install the debug app first?" || die "Stopped. Pick mode 1 (Metro) to build it."
      build_apk debug; install_apk ;;
    release)
      warn "The installed Zavi is a release build. It can't load code from Metro."
      confirm "Build and install the debug app instead?" || die "Stopped. Pick mode 1 (Metro) to build it."
      build_apk debug; install_apk ;;
    debug) ok "Debug build already installed" ;;
  esac
fi

step "Connecting $LABEL to Metro on port $PORT"
adb reverse "tcp:$PORT" "tcp:$PORT" >/dev/null || die "adb reverse failed for port $PORT."
ok "Port $PORT forwarded to this Mac"

if metro_running; then
  ok "Metro is already running on port $PORT, reusing it"
  open_in_dev_client
  ok "Opened Zavi on $LABEL. Reload with 'r' in the Metro terminal, or shake the device."
  exit 0
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "Port $PORT is used by something other than Metro. Free it, or pass -p <port>."
fi

# Open the app once Metro answers; Metro itself stays in the foreground.
(
  for _ in $(seq 1 120); do
    if metro_running; then open_in_dev_client; exit 0; fi
    sleep 1
  done
) &
OPENER_PID=$!
trap 'kill "$OPENER_PID" 2>/dev/null || true' EXIT INT TERM

step "Starting Metro (Ctrl+C to stop)"
info "${DIM}Zavi opens on $LABEL as soon as Metro is ready.${RESET}"
cd "$MOBILE_DIR"
metro_args=(expo start --dev-client --port "$PORT")
[[ $CLEAR_CACHE -eq 1 ]] && metro_args+=(--clear)
npx "${metro_args[@]}"
