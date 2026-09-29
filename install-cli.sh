#!/bin/bash
set -euo pipefail

scope_install_cli() (
  local root="${SCOPE_CLI_INSTALL_ROOT:-$HOME/.local/share/irudd-scope-cli}"
  local repository="https://github.com/alundgren/irudd-scope.git"
  local source="${SCOPE_CLI_SOURCE:-$root/source}" vp vp_version
  case "$(uname -s)" in Linux|Darwin) ;; *) echo "Scope CLI supports Linux and macOS." >&2; return 1 ;; esac
  case "$root" in /*) ;; *) echo "SCOPE_CLI_INSTALL_ROOT must be absolute." >&2; return 1 ;; esac
  case "$source" in /*) ;; *) echo "SCOPE_CLI_SOURCE must be absolute." >&2; return 1 ;; esac
  mkdir -p "$root"
  mkdir "$root/.install-lock" 2>/dev/null || { echo "Another CLI installation may be running. Retry when it finishes." >&2; return 1; }
  trap 'rmdir "$root/.install-lock" 2>/dev/null || true' EXIT
  export GIT_TERMINAL_PROMPT=0
  if [ -z "${SCOPE_CLI_SOURCE:-}" ]; then
    if [ ! -e "$source" ]; then git clone --depth 1 --branch main "$repository" "$source"; fi
    [ "$(git -C "$source" remote get-url origin)" = "$repository" ] || { echo "CLI source has a different Git remote." >&2; return 1; }
    [ -z "$(git -C "$source" status --porcelain)" ] || { echo "CLI source has local edits. Keep them in another checkout." >&2; return 1; }
    git -C "$source" fetch --depth 1 origin main
    git -C "$source" checkout --detach FETCH_HEAD
  fi
  vp="${SCOPE_VP:-$(command -v vp || true)}"
  if [ -z "$vp" ] || [ ! -x "$vp" ]; then
    vp_version="$(awk '/^  vite-plus: / { print $2; exit }' "$source/pnpm-workspace.yaml")"
    [ -n "$vp_version" ] || { echo "Scope does not specify a Vite+ version." >&2; return 1; }
    curl -fsSL --connect-timeout 15 --max-time 120 https://vite.plus/install.sh -o "$root/vite-plus-install.sh"
    VP_HOME="$HOME/.vite-plus" VP_VERSION="$vp_version" VP_NODE_MANAGER=no CI=true bash "$root/vite-plus-install.sh"
    rm "$root/vite-plus-install.sh"
    vp="$HOME/.vite-plus/bin/vp"
  fi
  export PATH="$(dirname "$vp"):$PATH" SCOPE_CLI_INSTALL_ROOT="$root"
  cd "$source"
  "$vp" install --frozen-lockfile --filter @irudd-scope/cli... --filter hub... --filter sharing...
  (cd packages/cli && "$vp" run build)
  (cd apps/hub && "$vp" run build)
  (cd apps/sharing && "$vp" run build)
  "$vp" exec node tools/package-cli.ts
)

scope_install_cli "$@"
