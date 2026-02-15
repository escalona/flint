#!/bin/sh

set -e

if pgrep -f "apps/gateway/src/index.ts" > /dev/null 2>&1; then
  echo "Flint gateway is already running, exiting."
  exit 0
fi

PORT="${PORT:-${FLINT_GATEWAY_PORT:-8788}}"
export PORT
export FLINT_GATEWAY_CWD="${FLINT_GATEWAY_CWD:-/workspace}"
export FLINT_GATEWAY_STORE_PATH="${FLINT_GATEWAY_STORE_PATH:-/workspace/.data/gateway-threads.json}"
# Claude Code disallows bypass-permissions as root unless sandbox mode is explicit.
export IS_SANDBOX="${IS_SANDBOX:-1}"

mkdir -p "$(dirname "$FLINT_GATEWAY_STORE_PATH")"

echo "Starting Flint gateway on port ${PORT}"
echo "Gateway cwd: ${FLINT_GATEWAY_CWD}"
echo "Gateway store: ${FLINT_GATEWAY_STORE_PATH}"

cd /workspace
exec bun run apps/gateway/src/index.ts
