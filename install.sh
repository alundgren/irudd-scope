#!/bin/bash
set -euo pipefail

scope_install() (
  local repository="https://github.com/alundgren/irudd-scope.git"
  local root="${SCOPE_INSTALL_ROOT:-$HOME/.local/share/irudd-scope}"
  local mode="${1:-install}" commit="${2:-}" source vp vp_version staging=""
  case "$mode" in
    install) [ "$#" -le 1 ] || { echo "Usage: install.sh" >&2; return 1; } ;;
    --prepare) [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid update commit." >&2; return 1; } ;;
    *) echo "Usage: install.sh [--prepare COMMIT]" >&2; return 1 ;;
  esac
  [ "$(uname -s)" = Darwin ] || { echo "Scope installation requires macOS." >&2; return 1; }
  case "$root" in /*) ;; *) echo "SCOPE_INSTALL_ROOT must be an absolute path." >&2; return 1 ;; esac
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "Install Apple's command line tools with xcode-select --install, then run this installer again." >&2
    return 1
  fi
  mkdir -p "$root"
  if ! mkdir "$root/.install-lock" 2>/dev/null; then
    echo "Another Scope install may be running. If it has stopped, remove $root/.install-lock and retry." >&2
    return 1
  fi
  trap 'rm -rf "$root/.install-lock"; if [ -n "${staging:-}" ]; then rm -rf "$staging"; fi' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  source="$root/source"
  export GIT_TERMINAL_PROMPT=0
  if [ ! -e "$source" ]; then
    echo "Cloning Scope…"
    git clone --depth 1 --branch main "$repository" "$source"
  fi
  [ "$(git -C "$source" remote get-url origin)" = "$repository" ] || {
    echo "Scope's source directory has a different Git remote. Move it aside and retry." >&2; return 1;
  }
  [ -z "$(git -C "$source" status --porcelain)" ] || {
    echo "Scope's source directory has local edits. Keep them in a separate checkout before updating." >&2; return 1;
  }
  echo "Fetching Scope main…"
  git -C "$source" fetch --depth 1 origin "${commit:-main}"
  commit="$(git -C "$source" rev-parse FETCH_HEAD)"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Git returned an invalid commit." >&2; return 1; }
  git -C "$source" checkout --detach "$commit"

  vp="${SCOPE_VP:-$(command -v vp || true)}"
  if [ -z "$vp" ] || [ ! -x "$vp" ]; then
    vp_version="$(awk '/^  vite-plus: / { print $2; exit }' "$source/pnpm-workspace.yaml")"
    [ -n "$vp_version" ] || { echo "Scope does not specify a Vite+ version." >&2; return 1; }
    echo "Installing Vite+ to build Scope…"
    curl -fsSL --connect-timeout 15 --max-time 120 https://vite.plus/install.sh -o "$root/.install-lock/vite-plus.sh"
    VP_HOME="$HOME/.vite-plus" VP_VERSION="$vp_version" VP_NODE_MANAGER=no CI=true bash "$root/.install-lock/vite-plus.sh"
    vp="$HOME/.vite-plus/bin/vp"
  fi
  [ -x "$vp" ] || { echo "Vite+ is unavailable. Install it from https://viteplus.dev and retry." >&2; return 1; }
  export PATH="$(dirname "$vp"):$PATH"
  export SCOPE_INSTALL_ROOT="$root" SCOPE_VP="$vp"
  unset ELECTRON_RUN_AS_NODE
  cd "$source"
  echo "Installing build dependencies…"
  "$vp" install --frozen-lockfile
  local build="$root/builds/$commit"
  if [ ! -d "$build/Scope.app" ]; then
    echo "Building Scope…"
    "$vp" run build
    mkdir -p "$root/builds"
    staging="$(mktemp -d "$root/builds/.preparing.XXXXXX")"
    "$vp" run package:desktop -- "$staging"
    # Every commit gets its own directory so a running app never loses its files.
    mv "$staging" "$build"
    staging=""
  fi
  "$vp" exec node tools/activate-installation.ts "$root" "$build" prepare
  if [ "$mode" = --prepare ]; then
    echo "Scope is ready to restart."
    return 0
  fi
  local applications="${SCOPE_APPLICATIONS_DIR:-$HOME/Applications}"
  local application="$applications/Scope.app"
  case "$applications" in /*) ;; *) echo "SCOPE_APPLICATIONS_DIR must be an absolute path." >&2; return 1 ;; esac
  "$vp" exec node tools/activate-installation.ts "$root" "$build" activate "$application"
  echo "Installed $application"
  echo "If Scope is already open, quit and reopen it to use this build."
  open "$application"
)

scope_install "$@"
