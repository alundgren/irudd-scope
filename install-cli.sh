#!/bin/bash
set -euo pipefail

scope_install_cli() (
  local root="${SCOPE_CLI_INSTALL_ROOT:-$HOME/.local/share/irudd-scope-cli}"
  local repository="https://github.com/alundgren/irudd-scope.git"
  local source="${SCOPE_CLI_SOURCE:-$root/source}" vp vp_version
  local commit="" prepare="0"
  if [ "${1:-}" = "--prepare" ] && [[ "${2:-}" =~ ^[0-9a-f]{40}$ ]] && [ "$#" = 2 ]; then
    prepare="1"
    commit="$2"
  elif [ "$#" != 0 ]; then
    echo "Use install-cli.sh or install-cli.sh --prepare COMMIT." >&2; return 1
  fi
  case "$(uname -s)" in Linux|Darwin) ;; *) echo "Scope CLI supports Linux and macOS." >&2; return 1 ;; esac
  case "$root" in /*) ;; *) echo "SCOPE_CLI_INSTALL_ROOT must be absolute." >&2; return 1 ;; esac
  case "$source" in /*) ;; *) echo "SCOPE_CLI_SOURCE must be absolute." >&2; return 1 ;; esac
  mkdir -p "$root"
  if [ "${SCOPE_CLI_LOCK_HELD:-}" != 1 ]; then
    if [ "$(uname -s)" = Linux ]; then
      command -v flock >/dev/null || { echo "Scope CLI installation requires flock from util-linux." >&2; return 1; }
      [ ! -d "$root/.install-lock" ] || { echo "An older CLI installer left an installation lock. Retry after it finishes, or remove $root/.install-lock if it is no longer running." >&2; return 1; }
      exec 9>"$root/.installation.lock"
      flock -n 9 || { echo "Another CLI installation is running. Retry when it finishes." >&2; return 1; }
    else
      mkdir "$root/.install-lock" 2>/dev/null || { echo "Another CLI installation may be running. Retry when it finishes." >&2; return 1; }
      trap 'rmdir "$root/.install-lock" 2>/dev/null || true' EXIT
    fi
  fi
  export GIT_TERMINAL_PROMPT=0
  if [ -z "${SCOPE_CLI_SOURCE:-}" ]; then
    if [ ! -e "$source" ]; then git clone --depth 1 --branch main "$repository" "$source"; fi
    [ "$(git -C "$source" remote get-url origin)" = "$repository" ] || { echo "CLI source has a different Git remote." >&2; return 1; }
    [ -z "$(git -C "$source" status --porcelain)" ] || { echo "CLI source has local edits. Keep them in another checkout." >&2; return 1; }
    if [ -n "$commit" ]; then
      if [ "$(git -C "$source" rev-parse --is-shallow-repository)" = true ]; then
        git -C "$source" fetch --unshallow origin main
      else
        git -C "$source" fetch origin main
      fi
      git -C "$source" merge-base --is-ancestor "$commit" FETCH_HEAD || { echo "The requested commit is not on Scope's main branch." >&2; return 1; }
      if [ -n "${SCOPE_CLI_CURRENT_COMMIT:-}" ]; then
        git -C "$source" merge-base --is-ancestor "$SCOPE_CLI_CURRENT_COMMIT" "$commit" || { echo "The remote has a newer or different version. Update the Mac first." >&2; return 1; }
      fi
    else
      git -C "$source" fetch --depth 1 origin main
      commit="FETCH_HEAD"
    fi
    git -C "$source" checkout --detach "$commit"
  elif [ -n "$commit" ] && [ "$(git -C "$source" rev-parse HEAD)" != "$commit" ]; then
    echo "The supplied checkout does not match the requested commit." >&2; return 1
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
  export PATH="$(dirname "$vp"):$PATH" SCOPE_CLI_INSTALL_ROOT="$root" SCOPE_VP="$vp" SCOPE_CLI_PREPARE="$prepare"
  cd "$source"
  "$vp" install --frozen-lockfile --filter @irudd-scope/cli... --filter hub...
  (cd packages/cli && "$vp" run build)
  (cd apps/hub && "$vp" run build)
  "$vp" exec node tools/package-cli.ts
)

scope_install_cli "$@"
