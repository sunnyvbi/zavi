#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-rravi149/zavi}"
[[ "$REPO" =~ ^rravi149/[A-Za-z0-9._-]+$ ]] || { printf 'ERROR: REPO must be rravi149/<repo>, got %s\n' "$REPO" >&2; exit 1; }
LABEL="zavi-mac"
if [ "$REPO" = rravi149/zavi ]; then PREFIX="$LABEL"; else PREFIX="${REPO##*/}"; fi
if [ "$REPO" = rravi149/zavi ]; then RUNNERS="${RUNNERS:-3}"; else RUNNERS="${RUNNERS:-2}"; fi
VITEST_WORKERS="${VITEST_WORKERS:-2}"
ROOT="$HOME/actions-runners"
BREW=/opt/homebrew
MAINT_PLIST="$HOME/Library/LaunchAgents/com.zavi.ci-maintenance.plist"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() { die "usage: $0 prereqs | install | check | remove   (read scripts/ci/MAC-RUNNER.md first)"; }
[ $# -eq 1 ] || usage

[ "$(uname -s)" = Darwin ] || die "run this on the spare Mac"
[ "$(uname -m)" = arm64 ] || die "expected Apple Silicon (arm64)"
[ -x "$BREW/bin/brew" ] || die "install Homebrew first (as the admin user): https://brew.sh"

assert_credential_free() {
  if id -Gn | tr ' ' '\n' | grep -qx admin; then
    die "$(id -un) is an admin. Run 'install' as the standard user zavi-ci."
  fi
  if [ -x "$BREW/bin/gh" ] && "$BREW/bin/gh" auth status >/dev/null 2>&1; then
    die "gh is logged in as $(id -un). Run: gh auth logout"
  fi
  if [ -d "$HOME/.ssh" ] && grep -rlq "PRIVATE KEY" "$HOME/.ssh" 2>/dev/null; then
    die "a private key is in ~/.ssh. This user must hold no keys."
  fi
  if [ -n "$(git config --global --get-all credential.helper 2>/dev/null)" ]; then
    die "a git credential helper is configured. Run: git config --global --unset-all credential.helper"
  fi
  if [ -s "$HOME/.git-credentials" ] || [ -s "$HOME/.netrc" ] || [ -s "$HOME/.npmrc" ]; then
    die "stored credentials found (~/.git-credentials, ~/.netrc or ~/.npmrc). Remove them."
  fi
}

case "$1" in
prereqs)
  say "tools the jobs expect on PATH (node for scripts, bash 5, jq)"
  for f in node@20 bash jq; do "$BREW/bin/brew" list "$f" >/dev/null 2>&1 || "$BREW/bin/brew" install "$f"; done
  say "Docker Desktop (rls-matrix boots Supabase in it; static-gates parses the compose file)"
  [ -d /Applications/Docker.app ] || "$BREW/bin/brew" install --cask docker
  say "never sleep, on any power source, lid open or closed (a sleeping Mac runs no jobs)"
  sudo pmset -a sleep 0 disksleep 0 standby 0 powernap 0 displaysleep 10 womp 1 autorestart 1
  sudo pmset -a disablesleep 1
  pmset -g | grep -E ' (sleep|disksleep|standby|SleepDisabled|autorestart) '
  say "close your home folder to other users (jobs run as zavi-ci and must not read your files)"
  chmod 700 "$HOME"
  ls -ld "$HOME"
  say "done. Next: create the Standard user zavi-ci, set it to log in automatically, then run 'install' as it."
  ;;

install)
  assert_credential_free
  if ls "$ROOT"/"$PREFIX"-*/.runner >/dev/null 2>&1; then
    die "$REPO runners are already configured in $ROOT. Run 'remove' first, then 'install'."
  fi
  : "${TOKEN:?set TOKEN=<registration token minted on your main Mac>}"
  stopped=()
  restart_stopped() { for s in "${stopped[@]:-}"; do [ -n "$s" ] && (cd "$s" && ./svc.sh start) || true; done; }
  trap restart_stopped EXIT
  for s in "$ROOT"/*/; do
    [ -f "$s/.runner" ] || continue
    say "pausing $(basename "$s") while the token is in use"
    (cd "$s" && ./svc.sh stop) || true
    stopped+=("${s%/}")
  done
  docker info >/dev/null 2>&1 || die "start Docker Desktop in this user's session (and enable 'Start when you sign in')"

  say "download the runner"
  ver="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
    | sed -nE 's/.*"tag_name": *"v([^"]+)".*/\1/p')"
  [ -n "$ver" ] || die "could not read the latest runner version"
  tgz="$ROOT/actions-runner-osx-arm64-$ver.tar.gz"
  mkdir -p "$ROOT"
  [ -f "$tgz" ] || curl -fsSL -o "$tgz" \
    "https://github.com/actions/runner/releases/download/v$ver/actions-runner-osx-arm64-$ver.tar.gz"

  for i in $(seq 1 "$RUNNERS"); do
    d="$ROOT/$PREFIX-$i"
    say "configure $REPO runner $i/$RUNNERS in $d"
    mkdir -p "$d"
    tar -xzf "$tgz" -C "$d"
    (cd "$d" && ./config.sh --unattended --replace \
      --url "https://github.com/$REPO" --token "$TOKEN" \
      --name "$(scutil --get LocalHostName)-$PREFIX-$i" \
      --labels "$LABEL" --work _work)
    # Homebrew first, so jobs get bash 5 + node 20 instead of macOS's bash 3.2.
    echo "$BREW/opt/node@20/bin:$BREW/bin:$BREW/sbin:$HOME/.docker/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" > "$d/.path"
    grep -q '^VITEST_MAX_WORKERS=' "$d/.env" 2>/dev/null || echo "VITEST_MAX_WORKERS=$VITEST_WORKERS" >> "$d/.env"
    (cd "$d" && ./svc.sh install && ./svc.sh start)
  done

  say "daily 04:00 cleanup so Docker leftovers and runner logs never fill the disk"
  mkdir -p "$(dirname "$MAINT_PLIST")"
  cat > "$MAINT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.zavi.ci-maintenance</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>export PATH=$HOME/.docker/bin:/usr/local/bin:$BREW/bin:/usr/bin:/bin;
docker container prune -f --filter until=24h; docker volume prune -af; docker image prune -f;
find $ROOT -path '*/_diag/*' -name '*.log' -mtime +7 -delete;
free_gb=\$(df -g / | awk 'NR==2{print \$4}');
if [ "\$free_gb" -lt 20 ]; then docker system prune -af; fi</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$ROOT/maintenance.log</string>
  <key>StandardErrorPath</key><string>$ROOT/maintenance.log</string>
</dict></plist>
PLIST
  launchctl unload "$MAINT_PLIST" 2>/dev/null || true
  launchctl load "$MAINT_PLIST"

  say "done. Check the runners show Idle at https://github.com/$REPO/settings/actions/runners"
  echo "Then, from your main Mac: gh variable set CI_RUNNER -b $LABEL -R $REPO"
  ;;

check)
  say "runner user (want: a standard user with no logins or keys)"
  assert_credential_free
  echo "$(id -un): ok"
  say "power (want: sleep 0, SleepDisabled 1, autorestart 1)"
  pmset -g | grep -E ' (sleep|SleepDisabled|autorestart) ' || true
  pmset -g batt | head -2
  say "runner services (want one per runner, each with a PID)"
  launchctl list | grep -E "actions\.runner|com\.zavi\.ci-maintenance" || echo "none loaded for $(id -un)"
  say "disk (want 20GB+ free)"
  df -h / | awk 'NR==2{print $4" free of "$2}'
  say "Docker"
  docker info --format '{{.MemTotal}} bytes RAM for Docker, {{.ContainersRunning}} containers running' 2>/dev/null \
    || echo "Docker is NOT running: rls-matrix and static-gates will fail"
  say "memory pressure (want: normal)"
  memory_pressure 2>/dev/null | tail -1
  ;;

remove)
  : "${TOKEN:?set TOKEN=<remove token minted on your main Mac for $REPO>}"
  for d in "$ROOT"/"$PREFIX"-*; do
    [ -f "$d/.runner" ] || continue
    say "removing $d"
    (cd "$d" && { ./svc.sh stop || true; ./svc.sh uninstall || true; } && ./config.sh remove --token "$TOKEN")
    rm -rf "$d"
  done
  if ! ls "$ROOT"/*/.runner >/dev/null 2>&1; then
    launchctl unload "$MAINT_PLIST" 2>/dev/null || true
    rm -f "$MAINT_PLIST"
  fi
  ;;

*)
  usage
  ;;
esac
