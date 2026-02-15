#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

publish_if_missing() {
  local package_dir="$1"
  cd "$ROOT_DIR/$package_dir"

  local name version
  name="$(node -p "require('./package.json').name")"
  version="$(node -p "require('./package.json').version")"

  if npm view "${name}@${version}" version >/dev/null 2>&1; then
    echo "[publish] skip ${name}@${version} (already exists)"
    return
  fi

  echo "[publish] publish ${name}@${version}"
  npm publish --access public
}

# Publish in dependency order.
publish_if_missing "packages/app-server-core"
publish_if_missing "packages/claude-app-server"
publish_if_missing "packages/pi-app-server"
publish_if_missing "packages/sdk"
publish_if_missing "packages/channels"
publish_if_missing "apps/tui"
publish_if_missing "apps/gateway"
publish_if_missing "packages/flint"
