#!/bin/bash
set -euo pipefail
scope_launcher="$0"
while [ -L "$scope_launcher" ]; do
  scope_directory="$(cd -P "$(dirname "$scope_launcher")" && pwd)"
  scope_launcher="$(readlink "$scope_launcher")"
  case "$scope_launcher" in /*) ;; *) scope_launcher="$scope_directory/$scope_launcher" ;; esac
done
scope_contents="$(cd -P "$(dirname "$scope_launcher")/../../.." && pwd)"
export ELECTRON_RUN_AS_NODE=1
exec "$scope_contents/MacOS/Scope" "$scope_contents/Resources/app/cli/main.mjs" "$@"
