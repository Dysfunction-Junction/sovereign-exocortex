#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "framer-readonly: Node.js was not found" >&2
  exit 127
fi
if [[ ! -f "${DIR}/dist/mcp-filter-proxy.js" ]]; then
  echo "framer-readonly: dist/mcp-filter-proxy.js is missing; run npm run build" >&2
  exit 1
fi
if [[ ! -f "${DIR}/framer-readonly-tools.manifest.json" ]]; then
  echo "framer-readonly: pinned tool manifest is missing" >&2
  exit 1
fi

# The full credential-bearing URL is loaded only inside the proxy from the
# private file; it never appears in this process's arguments or logs.
ALLOW_TOOLS="getProjectXml,getSelectedNodesXml,getNodeXml,searchFonts,exportReactComponents,readCodeFile,getComponentInsertUrlAndTypes,getProjectWebsiteUrl,getCMSCollections,getCMSItems"

exec "${NODE_BIN}" "${DIR}/dist/mcp-filter-proxy.js" \
  --upstream-url-secret "${HOME}/.secrets/framer_mcp_url" \
  --allow-tools "${ALLOW_TOOLS}" \
  --manifest "${DIR}/framer-readonly-tools.manifest.json" \
  --startup-timeout-ms 30000 \
  --call-timeout-ms 300000
