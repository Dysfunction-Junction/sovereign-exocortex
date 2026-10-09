#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "agent-mesh-coordination: Node.js 24+ was not found" >&2
  exit 127
fi
if [[ ! -f "${DIR}/dist/coordination-server.js" ]]; then
  echo "agent-mesh-coordination: build output is missing; run npm run build" >&2
  exit 1
fi

exec "${NODE_BIN}" "${DIR}/dist/coordination-server.js" "$@"
