#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
ENV_FILE="$HOME/.zavi/mirror.env"
die() { echo "mirror-upcar: $*" >&2; exit 1; }

need_env() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE"
  [ "$(stat -f '%Lp' "$ENV_FILE")" = "600" ] || die "$ENV_FILE must be chmod 600"
}

case "${1:-}" in
  migrate)
    need_env
    (cd "$ROOT/apps/backend" && node scripts/mirror-upcar.mjs --migrate)
    ;;
  plan) (cd "$ROOT/apps/backend" && node scripts/mirror-upcar.mjs --plan-only) ;;
  copy) need_env; (cd "$ROOT/apps/backend" && node scripts/mirror-upcar.mjs) ;;
  activity) need_env; (cd "$ROOT/apps/backend" && node scripts/mirror-upcar.mjs --activity) ;;
  *) die "usage: scripts/mirror-upcar.sh migrate | plan | copy | activity" ;;
esac
