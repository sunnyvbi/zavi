#!/usr/bin/env bash
set -euo pipefail

PG_VERSION=17.5.0
POSTGREST_VERSION=v14.5
AUTH_VERSION=v2.197.0
CACHE="${ZSI_TOOLS_DIR:-${RUNNER_TOOL_CACHE:-$HOME/.cache}/zsi-tools}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64)
    pg_art="embedded-postgres-binaries-darwin-arm64v8"; pg_sha=e9d3398e10c2ec926395498b03e75ad1a24eeaed82895e756a7e173b202cf6de
    rest_art="postgrest-${POSTGREST_VERSION}-macos-aarch64.tar.xz"; rest_sha=754b462c2b3e0d7a7defe44161c0d56233f41de6307e5cb136ef7d2e7ecc0124
    auth_art="auth-${AUTH_VERSION}-darwin-arm64.tar.gz"; auth_sha=3fb7998e7061e2c14f3f9555b1d94d447358c965395728e0d81eac82e0e5868b
    ;;
  Linux/x86_64)
    pg_art="embedded-postgres-binaries-linux-amd64"; pg_sha=646f3269075d1a23904127374e3cdbcef96beb32979fedee25d835877400fcbe
    rest_art="postgrest-${POSTGREST_VERSION}-linux-static-x86-64.tar.xz"; rest_sha=ab5cc7e974d4940447991804588cfb8b3f7b2c57b691f0905df04d51ede69470
    auth_art="auth-${AUTH_VERSION}-amd64.tar.xz"; auth_sha=b5c2991d1df760c9b099c1c2395a94bd1c2f83ed58901934921997179dc9f7ea
    ;;
  *) echo "site-isolation-deps: unsupported platform $os/$arch" >&2; exit 2 ;;
esac

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

fetch() {
  local url="$1" want="$2" dest="$3"
  if [ -f "$dest" ] && [ "$(sha256 "$dest")" = "$want" ]; then return 0; fi
  mkdir -p "$(dirname "$dest")"
  local tmp="$dest.part.$$"
  curl -sSfL --retry 3 --retry-delay 2 -o "$tmp" "$url"
  local got; got="$(sha256 "$tmp")"
  if [ "$got" != "$want" ]; then rm -f "$tmp"; echo "site-isolation-deps: sha256 mismatch for $url ($got)" >&2; exit 1; fi
  mv "$tmp" "$dest"
}

root="$CACHE/$os-$arch"
pg_dir="$root/postgres-$PG_VERSION"
rest_dir="$root/postgrest-$POSTGREST_VERSION"
auth_dir="$root/auth-$AUTH_VERSION"

if [ ! -x "$pg_dir/bin/initdb" ]; then
  jar="$root/dl/$pg_art-$PG_VERSION.jar"
  fetch "https://repo1.maven.org/maven2/io/zonky/test/postgres/$pg_art/$PG_VERSION/$pg_art-$PG_VERSION.jar" "$pg_sha" "$jar"
  work="$(mktemp -d)"
  unzip -q -o "$jar" -d "$work"
  rm -rf "$pg_dir.part" && mkdir -p "$pg_dir.part"
  tar -xJf "$work"/postgres-*.txz -C "$pg_dir.part"
  rm -rf "$work" "$pg_dir" && mv "$pg_dir.part" "$pg_dir"
fi
if [ ! -x "$rest_dir/postgrest" ]; then
  fetch "https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION/$rest_art" "$rest_sha" "$root/dl/$rest_art"
  rm -rf "$rest_dir.part" && mkdir -p "$rest_dir.part"
  tar -xJf "$root/dl/$rest_art" -C "$rest_dir.part"
  rm -rf "$rest_dir" && mv "$rest_dir.part" "$rest_dir"
fi
if [ ! -x "$auth_dir/auth" ]; then
  fetch "https://github.com/supabase/auth/releases/download/$AUTH_VERSION/$auth_art" "$auth_sha" "$root/dl/$auth_art"
  rm -rf "$auth_dir.part" && mkdir -p "$auth_dir.part"
  case "$auth_art" in *.tar.gz) tar -xzf "$root/dl/$auth_art" -C "$auth_dir.part" ;; *) tar -xJf "$root/dl/$auth_art" -C "$auth_dir.part" ;; esac
  rm -rf "$auth_dir" && mv "$auth_dir.part" "$auth_dir"
fi

echo "PGBIN=$pg_dir/bin"
echo "POSTGREST=$rest_dir/postgrest"
echo "GOTRUE=$auth_dir/auth"
if [ -n "${GITHUB_ENV:-}" ]; then
  { echo "PGBIN=$pg_dir/bin"; echo "POSTGREST=$rest_dir/postgrest"; echo "GOTRUE=$auth_dir/auth"; } >> "$GITHUB_ENV"
fi
