#!/usr/bin/env bash
# Cursor `stop` hook: reports finished mesh tasks back into the parent chat.
# Every failure path exits 0 so a mesh problem can never wedge the agent loop.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  exit 0
fi
NODE_MAJOR="$("${NODE_BIN}" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 24 ]]; then
  exit 0
fi
if [[ ! -f "${DIR}/dist/stop-hook-cli.js" ]]; then
  exit 0
fi

"${NODE_BIN}" "${DIR}/dist/stop-hook-cli.js" "$@" || true
exit 0
